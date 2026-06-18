"use strict";

// Claude Code engine adapter. Mirrors the role CodexAppServer plays for Codex,
// but Claude has no long-lived multi-thread server, so each turn shells out to
// `claude -p ... --resume <sessionId>` (Approach B). The stream-json output is
// parsed into the same normalized message shapes transcript.js produces, so the
// frontend renders Claude turns with zero changes.

const { spawn } = require("node:child_process");
const readline = require("node:readline");

// Map a Claude tool_use block to a normalized transcript event. Returns null to
// skip (unknown/no-op tools still render as a generic tool event).
function toolUseToItem(block) {
  const name = block.name || "";
  const input = block.input || {};
  if (name === "Bash") {
    return {
      role: "event",
      kind: "command",
      command: input.command || "",
      status: "running",
      exitCode: null,
      durationMs: null,
      output: "",
      _toolUseId: block.id || null,
    };
  }
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    const path = input.file_path || input.notebook_path || "";
    const change = name === "Write" ? "add" : "update";
    return {
      role: "event",
      kind: "fileChange",
      files: path ? [{ path, change, additions: 0, deletions: 0, diff: "" }] : [],
      _toolUseId: block.id || null,
    };
  }
  if (name === "WebSearch" || name === "WebFetch") {
    const queries = [input.query || input.url].filter(Boolean);
    return { role: "event", kind: "webSearch", queries, _toolUseId: block.id || null };
  }
  // Read, Grep, Glob, Task, TodoWrite, Skill, MCP tools, etc.
  const title = input.file_path || input.pattern || input.description || input.command || "";
  return {
    role: "event",
    kind: "tool",
    server: null,
    tool: name,
    status: "running",
    durationMs: null,
    title: title ? String(title).slice(0, 160) : null,
    _toolUseId: block.id || null,
  };
}

// Pure mapper: one Claude stream-json event -> a list of normalized outputs.
// Output shapes: {type:"session",sessionId} | {type:"delta",delta}
//              | {type:"item",item} | {type:"result",text} | {type:"error",message}
// tool_result attachment is handled by the engine (needs cross-event state).
function normalizeClaudeEvent(event) {
  if (!event || typeof event !== "object") return [];
  const out = [];

  if (event.type === "system" && event.subtype === "init" && event.session_id) {
    out.push({ type: "session", sessionId: event.session_id });
    return out;
  }

  // Live token streaming (only with --include-partial-messages).
  if (event.type === "stream_event") {
    const inner = event.event || {};
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      out.push({ type: "delta", delta: inner.delta.text || "" });
    }
    return out;
  }

  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      // Text blocks are streamed via stream_event deltas and finalized via the
      // `result` event, so they're not re-emitted here (avoids duplication).
      if (block.type === "tool_use") {
        const item = toolUseToItem(block);
        if (item) out.push({ type: "item", item });
      }
    }
    return out;
  }

  if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_result") {
        out.push({
          type: "toolResult",
          toolUseId: block.tool_use_id || null,
          output: extractToolResultText(block.content),
          isError: Boolean(block.is_error),
        });
      }
    }
    return out;
  }

  // Rolling usage window (Claude headless emits the 5-hour window: reset time
  // + allowed/limited status, but no used-percentage and no weekly window).
  if (event.type === "rate_limit_event" && event.rate_limit_info) {
    out.push({ type: "rateLimit", info: event.rate_limit_info });
    return out;
  }

  if (event.type === "result") {
    if (event.is_error) {
      out.push({ type: "error", message: event.result || event.subtype || "Claude turn failed" });
    } else {
      out.push({
        type: "result",
        text: typeof event.result === "string" ? event.result : "",
        durationMs: typeof event.duration_ms === "number" ? event.duration_ms : null,
        costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
      });
    }
    return out;
  }

  return out;
}

function extractToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Build the argv for a Claude headless turn.
function buildArgs(text, { sessionId, model, permissionMode } = {}) {
  const args = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    permissionMode || "acceptEdits",
  ];
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", model);
  return args;
}

class ClaudeEngine {
  constructor() {
    // Active turns by conversation id -> child process (for interrupt).
    this.active = new Map();
    // Conversations the user explicitly stopped, so the SIGTERM exit reads as
    // an intentional stop rather than a failure.
    this.interrupted = new Set();
  }

  // Run one turn. `onEvent(evt)` receives SSE-shaped events:
  //   {type:"delta",delta} | {type:"item",item} | {type:"turnCompleted"}
  // Resolves { reply, sessionId, items } when the process exits.
  runTurn(convId, text, { cwd, sessionId, model, permissionMode } = {}, onEvent = () => {}) {
    return new Promise((resolve, reject) => {
      const args = buildArgs(text, { sessionId, model, permissionMode });
      let proc;
      try {
        proc = spawn("claude", args, { cwd: cwd || process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      this.active.set(convId, proc);

      let capturedSession = sessionId || null;
      let reply = "";
      let streamed = "";
      let stderr = "";
      let durationMs = null;
      let costUsd = null;
      let rateLimit = null;
      const items = []; // normalized transcript items emitted this turn
      const toolItemsById = new Map();

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return; // skip malformed line, keep streaming
        }
        for (const o of normalizeClaudeEvent(event)) {
          if (o.type === "session") {
            capturedSession = o.sessionId;
          } else if (o.type === "delta") {
            streamed += o.delta;
            onEvent({ type: "delta", delta: o.delta });
          } else if (o.type === "item") {
            if (o.item._toolUseId) toolItemsById.set(o.item._toolUseId, o.item);
            items.push(o.item);
            onEvent({ type: "item", item: stripInternal(o.item) });
          } else if (o.type === "toolResult") {
            const target = o.toolUseId && toolItemsById.get(o.toolUseId);
            if (target) {
              if (target.kind === "command") {
                target.output = o.output;
                target.status = o.isError ? "failed" : "completed";
                target.exitCode = o.isError ? 1 : 0;
              } else if (target.kind === "tool") {
                target.status = o.isError ? "failed" : "completed";
                target.title = target.title || o.output.slice(0, 160);
              }
            }
          } else if (o.type === "rateLimit") {
            rateLimit = o.info;
          } else if (o.type === "result") {
            reply = o.text || streamed;
            durationMs = o.durationMs;
            costUsd = o.costUsd;
          } else if (o.type === "error") {
            reply = reply || o.text || "";
            stderr += `\n${o.message}`;
          }
        }
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("error", (error) => {
        this.active.delete(convId);
        reject(error);
      });

      proc.on("close", (code) => {
        this.active.delete(convId);
        onEvent({ type: "turnCompleted" });
        const stopped = this.interrupted.delete(convId);
        // An intentional stop (SIGTERM) is not a failure: return whatever
        // streamed so far, flagged as stopped, instead of rejecting.
        if (stopped) {
          resolve({
            reply: (reply || streamed).trim(),
            sessionId: capturedSession,
            items: items.map(stripInternal),
            durationMs,
            costUsd,
            rateLimit,
            stopped: true,
          });
          return;
        }
        if (code !== 0 && !reply) {
          reject(new Error(claudeError(code, stderr)));
          return;
        }
        resolve({
          reply: (reply || streamed).trim(),
          sessionId: capturedSession,
          items: items.map(stripInternal),
          durationMs,
          costUsd,
          rateLimit,
        });
      });
    });
  }

  interrupt(convId) {
    const proc = this.active.get(convId);
    if (!proc) return false;
    this.interrupted.add(convId);
    proc.kill("SIGTERM");
    this.active.delete(convId);
    return true;
  }

  isActive(convId) {
    return this.active.has(convId);
  }
}

function stripInternal(item) {
  const { _toolUseId, ...rest } = item;
  return rest;
}

function claudeError(code, stderr) {
  const tail = (stderr || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
  if (/not logged in|authentication|login/i.test(tail)) {
    return "Claude 未登录：请在终端运行 `claude` 登录后重试。";
  }
  if (/command not found|ENOENT/i.test(tail)) {
    return "未找到 `claude` 命令：请确认已安装 Claude Code CLI。";
  }
  return `Claude 退出码 ${code}${tail ? `：${tail}` : ""}`;
}

module.exports = { ClaudeEngine, normalizeClaudeEvent, toolUseToItem, buildArgs };
