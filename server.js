const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const {
  APPROVAL_METHODS,
  classifyMessage,
  summarizeApproval,
  buildApprovalResult,
  matchWaiter,
  sanitizeSettings,
  sanitizeImages,
} = require("./protocol");
const { itemToMessage } = require("./transcript");
const { ClaudeEngine } = require("./claude-engine");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);
const root = __dirname;
const logFile = path.join(root, "logs", "server.log");
try {
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
} catch {
  /* logs dir best-effort */
}

// Append-only error/event log so production issues leave a trace on disk.
function logToFile(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  fs.appendFile(logFile, line, () => {});
  if (level === "error") console.error(line.trim());
}

class CodexAppServer {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = [];
    this.activeTurns = new Set();
    this.events = [];
    this.initialized = false;
    // Server-initiated approval requests awaiting a user decision.
    this.approvals = new Map();
    // SSE subscribers for live turn streaming: { res, threadId }.
    this.streamSubs = new Set();
    // native threadId → alias id (a conversation id). Lets a Codex turn that
    // runs under a logical conversation deliver its stream to the client, which
    // subscribed by conversation id, not the native Codex thread id.
    this.streamAliases = new Map();
  }

  addStreamSubscriber(res, threadId) {
    const sub = { res, threadId };
    this.streamSubs.add(sub);
    return () => this.streamSubs.delete(sub);
  }

  setStreamAlias(nativeId, aliasId) {
    if (nativeId && aliasId) this.streamAliases.set(nativeId, aliasId);
  }

  clearStreamAlias(nativeId) {
    this.streamAliases.delete(nativeId);
  }

  emitStream(threadId, event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    const alias = this.streamAliases.get(threadId);
    for (const sub of this.streamSubs) {
      if (!sub.threadId || sub.threadId === threadId || sub.threadId === alias) {
        try {
          sub.res.write(payload);
        } catch {
          this.streamSubs.delete(sub);
        }
      }
    }
  }

  async ensure() {
    if (this.proc && !this.proc.killed && this.initialized) return;

    this.proc = spawn("codex", ["app-server"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.initialized = false;

    this.proc.stderr.on("data", (chunk) => {
      this.addEvent(`codex.stderr: ${chunk.toString().trim()}`);
    });
    this.proc.on("exit", (code) => {
      this.addEvent(`codex.exit: ${code}`);
      this.initialized = false;
      this.proc = null;
    });

    const lines = readline.createInterface({ input: this.proc.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_web_demo",
        title: "Codex Web Demo",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.initialized = true;
    this.addEvent("codex.ready");
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.addEvent(`codex.invalid_json: ${line.slice(0, 120)}`);
      return;
    }

    const classified = classifyMessage(message);

    if (classified.kind === "serverRequest") {
      this.handleServerRequest(message);
      return;
    }

    if (classified.kind === "response") {
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
      return;
    }

    this.handleNotification(message);
  }

  // Server -> client requests (e.g. command/file-change approvals) MUST be
  // answered or the turn hangs. Queue approvals for the UI; reply to anything
  // else with an error so app-server does not wait forever.
  handleServerRequest(message) {
    const { id, method, params = {} } = message;
    if (APPROVAL_METHODS.has(method)) {
      const summary = summarizeApproval(method, params);
      this.approvals.set(String(id), { id, method, summary, createdAt: Date.now() });
      this.addEvent(
        `approval.requested: ${summary.kind} (${summary.command || summary.reason || method})`,
        summary.threadId || null,
      );
      return;
    }
    this.addEvent(`server.request.unhandled: ${method}`);
    this.writeRaw({ id, error: { code: -32601, message: `web client cannot handle ${method}` } });
  }

  // Answer a queued approval. Returns false if the id is unknown.
  respondApproval(id, decision) {
    const key = String(id);
    const entry = this.approvals.get(key);
    if (!entry) return false;
    this.approvals.delete(key);
    this.writeRaw(buildApprovalResult(entry.id, decision));
    this.addEvent(`approval.${decision}: ${entry.summary.kind}`, entry.summary.threadId || null);
    return true;
  }

  pendingApprovals() {
    return [...this.approvals.values()].map((entry) => ({
      id: String(entry.id),
      kind: entry.summary.kind,
      summary: entry.summary,
    }));
  }

  writeRaw(payload) {
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    }
  }

  handleNotification(message) {
    const method = message.method || "notification";
    const params = message.params || {};
    this.addEvent(formatNotification(message), message.params?.threadId || null);

    if (method === "item/agentMessage/delta") {
      const waiter = this.findTurnWaiter(params.threadId, params.turnId);
      if (waiter) waiter.text += params.delta || "";
      this.emitStream(params.threadId, { type: "delta", delta: params.delta || "" });
    }

    if (method === "turn/started") {
      const waiter = this.findTurnWaiter(params.threadId, params.turn?.id);
      if (waiter) waiter.turnId = params.turn?.id || waiter.turnId;
      if (params.threadId) this.activeTurns.add(params.threadId);
      this.emitStream(params.threadId, { type: "turnStarted", turnId: params.turn?.id });
    }

    if (method === "turn/completed") {
      if (params.threadId) this.activeTurns.delete(params.threadId);
      this.emitStream(params.threadId, { type: "turnCompleted" });
    }

    if (method === "item/started" && params.item?.type) {
      this.emitStream(params.threadId, { type: "progress", itemType: params.item.type });
    }

    if (
      method === "item/completed" &&
      ["fileChange", "commandExecution", "reasoning", "webSearch", "mcpToolCall"].includes(params.item?.type)
    ) {
      const item = itemToMessage(params.item);
      if (item) this.emitStream(params.threadId, { type: "item", item });
    }

    if (method === "error") {
      const waiter = this.findTurnWaiter(params.threadId, params.turnId);
      if (!params.willRetry && params.threadId) this.activeTurns.delete(params.threadId);
      if (waiter && !params.willRetry) {
        this.removeTurnWaiter(waiter);
        waiter.reject(new Error(params.error?.message || "Codex turn failed"));
      }
    }

    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const waiter = this.findTurnWaiter(params.threadId, params.turnId);
      if (waiter?.text.trim()) {
        this.removeTurnWaiter(waiter);
        waiter.resolve({ text: waiter.text.trim(), turn: params.turn, partial: true });
      }
    }

    if (method === "turn/completed") {
      const waiter = this.findTurnWaiter(params.threadId, params.turn?.id);
      if (waiter) {
        this.removeTurnWaiter(waiter);
        waiter.resolve({ text: waiter.text.trim(), turn: params.turn, partial: false });
      }
    }
  }

  request(method, params) {
    if (!this.proc || this.proc.killed) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextId++;
    const payload = { method, id, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 120000);
      if (timer.unref) timer.unref();
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async listThreads(limit = 80) {
    await this.ensure();
    return this.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
    });
  }

  async readThread(threadId) {
    await this.ensure();
    return this.request("thread/read", { threadId, includeTurns: true });
  }

  async listModels() {
    await this.ensure();
    return this.request("model/list", {});
  }

  async renameThread(threadId, name) {
    await this.ensure();
    return this.request("thread/name/set", { threadId, name });
  }

  async archiveThread(threadId) {
    await this.ensure();
    return this.request("thread/archive", { threadId });
  }

  async compactThread(threadId) {
    await this.ensure();
    return this.request("thread/compact/start", { threadId });
  }

  async forkThread(threadId, cwd) {
    await this.ensure();
    return this.request("thread/fork", { threadId, cwd });
  }

  async rollbackThread(threadId, numTurns) {
    await this.ensure();
    return this.request("thread/rollback", { threadId, numTurns });
  }

  async steerTurn(threadId, text) {
    const waiter = this.turnWaiters.find((w) => w.threadId === threadId);
    if (!waiter || !waiter.turnId) return false;
    this.request("turn/steer", {
      threadId,
      expectedTurnId: waiter.turnId,
      input: [{ type: "text", text, text_elements: [] }],
    }).catch(() => {});
    this.addEvent(`turn.steer: ${threadId}`, threadId);
    return true;
  }

  async startReview(threadId) {
    await this.ensure();
    return this.request("review/start", { threadId, target: { type: "uncommitted" } });
  }

  async searchThreads(searchTerm) {
    await this.ensure();
    return this.request("thread/search", { searchTerm });
  }

  async listSkills(cwds) {
    await this.ensure();
    return this.request("skills/list", { cwds });
  }

  async listMcpServers() {
    await this.ensure();
    return this.request("mcpServerStatus/list", {});
  }

  async listPlugins() {
    await this.ensure();
    return this.request("plugin/list", {});
  }

  async fuzzyFiles(query, roots) {
    await this.ensure();
    return this.request("fuzzyFileSearch", { query, roots });
  }

  async authStatus() {
    await this.ensure();
    return this.request("getAuthStatus", {});
  }

  async gitDiff(cwd) {
    await this.ensure();
    return this.request("gitDiffToRemote", { cwd });
  }

  async conversationSummary(threadId) {
    await this.ensure();
    return this.request("getConversationSummary", { conversationId: threadId });
  }

  async accountInfo() {
    await this.ensure();
    const [account, limits] = await Promise.all([
      this.request("account/read", {}),
      this.request("account/rateLimits/read", {}),
    ]);
    return { account: account.account, rateLimits: limits.rateLimits };
  }

  async startThread(cwd, settings = {}) {
    await this.ensure();
    const params = {
      cwd,
      approvalPolicy: settings.approvalPolicy || "on-request",
      sandbox: settings.sandbox || "workspace-write",
    };
    if (settings.model) params.model = settings.model;
    return this.request("thread/start", params);
  }

  async resumeThread(threadId, cwd, settings = {}) {
    await this.ensure();
    return this.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: settings.approvalPolicy || "on-request",
      sandbox: settings.sandbox || "workspace-write",
    });
  }

  async runTurn(threadId, text, cwd, settings = {}, images = []) {
    await this.ensure();
    this.assertTurnAvailable(threadId);

    return new Promise((resolve, reject) => {
      const waiter = {
        threadId,
        turnId: null,
        text: "",
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      const timeout = setTimeout(() => {
        this.removeTurnWaiter(waiter);
        reject(new Error("turn timed out"));
      }, 600000);
      this.turnWaiters.push(waiter);

      const input = [{ type: "text", text, text_elements: [] }];
      for (const url of images) input.push({ type: "image", url, detail: null });
      const turnParams = { threadId, cwd, input };
      if (settings.model) turnParams.model = settings.model;
      if (settings.effort) turnParams.effort = settings.effort;
      if (settings.approvalPolicy) turnParams.approvalPolicy = settings.approvalPolicy;

      this.request("turn/start", turnParams)
        .then((result) => {
          waiter.turnId = result.turn?.id || waiter.turnId;
        })
        .catch((error) => {
          this.removeTurnWaiter(waiter);
          waiter.reject(error);
        });
    });
  }

  findTurnWaiter(threadId, turnId) {
    return matchWaiter(this.turnWaiters, threadId, turnId);
  }

  hasActiveTurn(threadId) {
    return this.activeTurns.has(threadId) || this.turnWaiters.some((waiter) => waiter.threadId === threadId);
  }

  assertTurnAvailable(threadId) {
    if (!this.hasActiveTurn(threadId)) return;
    const error = new Error("turn already running on this thread");
    error.statusCode = 409;
    throw error;
  }

  // Interrupt the in-flight turn on a thread. The app-server then ends the turn,
  // which resolves the waiting runTurn promise normally.
  async interruptTurn(threadId) {
    const waiter = this.turnWaiters.find((w) => w.threadId === threadId);
    if (!waiter || !waiter.turnId) return false;
    this.request("turn/interrupt", { threadId, turnId: waiter.turnId }).catch(() => {});
    this.addEvent(`turn.interrupt: ${threadId}`, threadId);
    return true;
  }

  removeTurnWaiter(waiter) {
    const index = this.turnWaiters.indexOf(waiter);
    if (index >= 0) this.turnWaiters.splice(index, 1);
  }

  addEvent(text, threadId = null) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    this.events.push({ text: `${time} ${text}`, threadId });
    this.events = this.events.slice(-300);
  }

  // Events for one thread = that thread's events + system events (threadId null).
  // Omit threadId to get everything (back-compat).
  eventsFor(threadId) {
    const list = threadId
      ? this.events.filter((e) => e.threadId === threadId || e.threadId === null)
      : this.events;
    return list.map((e) => e.text).slice(-100);
  }
}

const codex = new CodexAppServer();
const claude = new ClaudeEngine();

// Web-created conversations are logical records that can switch engines in
// place: each holds both engines' native session ids + one unified transcript.
// They persist to claude-threads.json (kept for back-compat) so they survive
// restarts. Mac-app Codex threads (from thread/list) are NOT stored here.
const convStoreFile = path.join(root, "claude-threads.json");

class ConvStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      const arr = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const raw of arr) this.map.set(raw.id, migrateConv(raw));
    } catch {
      /* no store yet */
    }
  }
  save() {
    fs.writeFile(this.file, JSON.stringify([...this.map.values()]), () => {});
  }
  has(id) {
    return this.map.has(id);
  }
  get(id) {
    return this.map.get(id);
  }
  all() {
    return [...this.map.values()];
  }
  create(cwd, engine = "codex") {
    const id = `conv-${crypto.randomBytes(8).toString("hex")}`;
    const conv = {
      id,
      engine: engine === "claude" ? "claude" : "codex",
      codexThreadId: null,
      claudeSessionId: null,
      cwd: cwd || root,
      title: "新对话",
      updatedAt: Date.now() / 1000,
      messages: [],
      lastTurn: null,
      rateLimit: null,
      pendingSeed: null,
      engineCursor: {},
    };
    this.map.set(id, conv);
    this.save();
    return conv;
  }
  remove(id) {
    const ok = this.map.delete(id);
    if (ok) this.save();
    return ok;
  }
}

// Bring older / Claude-only records up to the dual-engine shape.
function migrateConv(raw) {
  return {
    id: raw.id,
    engine: raw.engine === "codex" ? "codex" : "claude",
    codexThreadId: raw.codexThreadId ?? null,
    // Older Claude records stored the session under `nativeId`.
    claudeSessionId: raw.claudeSessionId ?? raw.nativeId ?? null,
    cwd: raw.cwd || root,
    title: raw.title || "新对话",
    updatedAt: raw.updatedAt || Date.now() / 1000,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    lastTurn: raw.lastTurn || null,
    rateLimit: raw.rateLimit || null,
    pendingSeed: raw.pendingSeed ?? null,
    engineCursor: raw.engineCursor && typeof raw.engineCursor === "object" ? raw.engineCursor : {},
  };
}

const convStore = new ConvStore(convStoreFile);

// A web thread id is store-managed (logical conversation) iff the store knows it.
function isConv(id) {
  return convStore.has(id);
}

// The native session id for a conversation's current engine (null until the
// first turn on that engine lazily starts one).
function nativeIdFor(conv) {
  return conv.engine === "claude" ? conv.claudeSessionId : conv.codexThreadId;
}

function normalizeConv(conv, includeMessages) {
  return {
    id: conv.id,
    engine: conv.engine,
    projectId: conv.cwd,
    title: conv.title || "新对话",
    updatedAt: formatTime(conv.updatedAt),
    path: conv.cwd,
    // No native session yet on this engine → "ready" (not the Codex-flavored
    // "notLoaded", which reads like an error in the UI).
    status: { type: nativeIdFor(conv) ? "idle" : "ready" },
    lastTurn: conv.lastTurn || null,
    rateLimit: conv.rateLimit || null,
    messages: includeMessages ? externalizeImages(structuredClone(conv.messages)) : [],
  };
}

// Run one turn on a store-managed conversation, routing to its current engine.
// `text` is the user's real message (shown in the transcript); any pending
// switch-context seed is prepended only in what's sent to the model.
async function runConvTurn(conv, text, settings = {}) {
  const seed = conv.pendingSeed;
  conv.pendingSeed = null; // consumed by this turn regardless of outcome
  const sentText = seed ? `${seed}\n\n${text}` : text;
  if (conv.engine === "claude") return runClaudeConvTurn(conv, text, sentText, settings);
  return runCodexConvTurn(conv, text, sentText, settings);
}

// Append the just-completed turn's agent/event items (not the user message,
// which we record ourselves) into the unified transcript.
function appendLastCodexTurn(conv, thread) {
  const lastTurn = (thread.turns || []).at(-1);
  if (!lastTurn) return "";
  const items = extractMessages({ turns: [lastTurn] }).filter((m) => m.role !== "user");
  for (const item of items) conv.messages.push(item);
  const reply = items.filter((m) => m.role === "agent").at(-1);
  return reply?.text || "";
}

async function runCodexConvTurn(conv, text, sentText, settings) {
  // Lazily start the Codex thread the first time this conversation uses Codex.
  if (!conv.codexThreadId) {
    const started = await codex.startThread(conv.cwd, settings);
    conv.codexThreadId = started.thread.id;
    convStore.save();
  }
  const threadId = conv.codexThreadId;
  codex.assertTurnAvailable(threadId);
  conv.messages.push({ role: "user", text, images: [] });
  conv.updatedAt = Date.now() / 1000;
  convStore.save();
  // Route Codex's native-threadId stream events to this conversation's SSE.
  codex.setStreamAlias(threadId, conv.id);
  codex.addEvent(`conv.codex.turn.start: ${conv.id}`, conv.id);
  try {
    await codex.resumeThread(threadId, conv.cwd, settings).catch((error) => {
      codex.addEvent(`thread.resume.skipped: ${error.message}`, conv.id);
    });
    const turn = await codex.runTurn(threadId, sentText, conv.cwd, settings, []);
    const result = await codex.readThread(threadId);
    const reply = appendLastCodexTurn(conv, result.thread) || turn.text || "";
    conv.title = conv.title === "新对话" && text ? text.slice(0, 24) : conv.title;
    conv.lastTurn = { durationMs: null, costUsd: null };
    conv.updatedAt = Date.now() / 1000;
    convStore.save();
    codex.addEvent(`conv.codex.turn.completed: ${conv.id}`, conv.id);
    return { reply, partial: Boolean(turn.partial) };
  } catch (error) {
    codex.addEvent(`conv.codex.turn.failed: ${error.message}`, conv.id);
    convStore.save();
    throw error;
  } finally {
    codex.clearStreamAlias(threadId);
  }
}

// Run a Claude turn on a stored conversation, streaming via the shared SSE hub
// (reuses codex.emitStream — subscribers are keyed by conversation id).
async function runClaudeConvTurn(conv, text, sentText, settings = {}) {
  // One turn at a time per conversation: two `claude --resume <id>` processes on
  // the same session would race-append to its rollout and corrupt it.
  if (claude.isActive(conv.id)) {
    const error = new Error("turn already running on this thread");
    error.statusCode = 409;
    throw error;
  }
  conv.messages.push({ role: "user", text, images: [] });
  conv.updatedAt = Date.now() / 1000;
  convStore.save(); // persist the user message up-front so a failure isn't lost
  const onEvent = (evt) => codex.emitStream(conv.id, evt);
  codex.addEvent(`claude.turn.start: ${conv.id}`, conv.id);
  try {
    const turn = await claude.runTurn(
      conv.id,
      sentText,
      // Codex and Claude have disjoint model ids; only forward a model that is
      // actually a Claude model, otherwise let Claude pick its default.
      { cwd: conv.cwd, sessionId: conv.claudeSessionId, model: claudeModel(settings.model) },
      onEvent,
    );
    for (const item of turn.items) conv.messages.push(item);
    const replyText = turn.stopped ? turn.reply || "（已停止）" : turn.reply;
    if (replyText) {
      // durationMs/turnStatus drive the "Claude · 12.3s" header, matching Codex.
      conv.messages.push({
        role: "agent",
        text: replyText,
        images: [],
        durationMs: turn.durationMs || null,
        turnStatus: turn.stopped ? "stopped" : "completed",
      });
    }
    if (turn.sessionId) conv.claudeSessionId = turn.sessionId;
    conv.title = conv.title === "新对话" && text ? text.slice(0, 24) : conv.title;
    conv.lastTurn = { durationMs: turn.durationMs || null, costUsd: turn.costUsd ?? null };
    if (turn.rateLimit) conv.rateLimit = turn.rateLimit;
    conv.updatedAt = Date.now() / 1000;
    convStore.save();
    const cost = turn.costUsd != null ? ` ($${turn.costUsd.toFixed(4)})` : "";
    codex.addEvent(`claude.turn.completed: ${conv.id}${cost}`, conv.id);
    return { reply: (turn.stopped ? turn.reply || "（已停止）" : turn.reply) || "", partial: false };
  } catch (error) {
    codex.addEvent(`claude.turn.failed: ${error.message}`, conv.id);
    convStore.save(); // keep the user message; reload shows it for a retry
    throw error;
  }
}

// Forward only values Claude's --model accepts (full `claude-*` ids or the
// latest-tracking aliases); drop Codex ids like gpt-5-codex so they never leak.
const CLAUDE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
function claudeModel(model) {
  if (typeof model !== "string" || !model) return undefined;
  if (model.startsWith("claude")) return model;
  if (CLAUDE_MODEL_ALIASES.has(model)) return model;
  return undefined;
}

// Flatten a conversation's transcript into a seed prompt so a switched-to engine
// starts with the prior context (text only; tool calls/diffs don't transfer).
function buildReplayPrompt(messages = []) {
  // Only the most recent text turns — older context rarely matters for a
  // hand-off and a giant blob is unwieldy in the composer on a phone.
  const recent = messages.filter((m) => (m.role === "user" || m.role === "agent") && m.text).slice(-12);
  const lines = ["以下是此前对话的记录，请在此基础上继续：\n"];
  for (const m of recent) {
    lines.push(`${m.role === "user" ? "【我】" : "【助手】"}${m.text}`);
  }
  lines.push("\n（以上为历史上下文，下面请继续。）");
  return lines.join("\n").slice(0, 6000);
}

// Flip a stored conversation to another engine in place: same id + transcript,
// just a different active engine. The next turn silently carries the context
// the target engine is missing (only the delta since it last ran, so switching
// back to a warm session stays mostly cache-hit). Pure mutation (no I/O) so it
// stays unit-testable; the caller persists. Returns the updated conv.
function switchConvEngine(conv, to) {
  const target = to === "claude" ? "claude" : "codex";
  if (conv.engine === target) return conv;
  const from = conv.engine;
  // Context the target engine hasn't seen: everything since it last ran (or the
  // recent transcript on first switch — buildReplayPrompt caps to the tail).
  const cursor = conv.engineCursor[target] ?? 0;
  const delta = conv.messages.slice(cursor);
  conv.engineCursor[from] = conv.messages.length; // mark where we left `from`
  conv.engine = target;
  conv.pendingSeed = delta.length ? buildReplayPrompt(delta) : null;
  conv.updatedAt = Date.now() / 1000;
  return conv;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (url.pathname.startsWith("/img/")) {
      const id = url.pathname.slice(5);
      const img = imageStore.get(id);
      if (!img) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": img.contentType,
        "Cache-Control": "public, max-age=86400",
        ...corsHeaders(),
      });
      res.end(img.buffer);
      return;
    }
    if (url.pathname === "/health") return json(res, { ok: true });
    if (url.pathname === "/api/events") {
      const threadId = url.searchParams.get("threadId");
      return json(res, { events: codex.eventsFor(threadId), approvals: codex.pendingApprovals() });
    }
    if (url.pathname === "/api/stream" && req.method === "GET") {
      const threadId = url.searchParams.get("threadId");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(),
      });
      res.write(": connected\n\n");
      const off = codex.addStreamSubscriber(res, threadId);
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* closed */
        }
      }, 15000);
      if (heartbeat.unref) heartbeat.unref();
      req.on("close", () => {
        clearInterval(heartbeat);
        off();
      });
      return;
    }
    if (url.pathname === "/api/approvals" && req.method === "GET") {
      return json(res, { approvals: codex.pendingApprovals() });
    }
    if (url.pathname.match(/^\/api\/approvals\/[^/]+$/) && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJson(req);
      const ok = codex.respondApproval(id, body.decision);
      return json(res, { ok, approvals: codex.pendingApprovals() }, ok ? 200 : 404);
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/api/sync") return json(res, await syncPayload());
    if (url.pathname === "/api/models") {
      const result = await codex.listModels();
      const models = (result.data || []).map((m) => ({
        id: m.id,
        displayName: m.displayName || m.id,
        efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
      }));
      return json(res, { models });
    }
    if (url.pathname === "/api/account") {
      return json(res, await codex.accountInfo());
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+$/) && req.method === "GET") {
      const threadId = decodeURIComponent(url.pathname.split("/")[3] || "");
      if (isConv(threadId)) {
        return json(res, { thread: normalizeConv(convStore.get(threadId), true), events: codex.eventsFor(threadId) });
      }
      const result = await codex.readThread(threadId);
      return json(res, { thread: normalizeThread(result.thread, true), events: codex.eventsFor(threadId) });
    }
    if (url.pathname === "/api/threads" && req.method === "POST") {
      // Every web-created conversation is a store-managed logical record (lazy
      // native session) so it can switch engines in place later.
      const body = await readJson(req);
      const conv = convStore.create(body.cwd || root, body.engine === "claude" ? "claude" : "codex");
      codex.addEvent(`conv.started: ${conv.engine} ${conv.cwd}`, conv.id);
      return json(res, { thread: normalizeConv(conv, false), events: codex.eventsFor(conv.id) });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/switch-engine$/) && req.method === "POST") {
      const sourceId = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJson(req);
      const to = body.to === "codex" ? "codex" : "claude";
      // Store-managed conversation → flip engine in place (same id + transcript).
      if (isConv(sourceId)) {
        const conv = convStore.get(sourceId);
        const from = conv.engine;
        switchConvEngine(conv, to);
        convStore.save();
        codex.addEvent(`engine.switched.inplace: ${from}→${conv.engine} (${conv.id})`, conv.id);
        return json(res, { thread: normalizeConv(conv, false), inPlace: true });
      }
      // Mac-app Codex thread (no logical wrapper) → fork into a new conversation,
      // seeding the recent transcript for the user to review/send.
      const srcThread = (await codex.readThread(sourceId)).thread;
      const sourceTitle = srcThread.name || trimPreview(srcThread.preview);
      const cwd = body.cwd || root;
      const seedPrompt = buildReplayPrompt(extractMessages(srcThread));
      const conv = convStore.create(cwd, to);
      if (sourceTitle) conv.title = sourceTitle;
      conv.pendingSeed = seedPrompt;
      convStore.save();
      codex.addEvent(`engine.switch.fork: → ${to} (${conv.id})`, conv.id);
      return json(res, { thread: normalizeConv(conv, false), inPlace: false });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/interrupt$/) && req.method === "POST") {
      const threadId = decodeURIComponent(url.pathname.split("/")[3]);
      let ok = false;
      if (isConv(threadId)) {
        const conv = convStore.get(threadId);
        ok = conv.engine === "claude" ? claude.interrupt(threadId) : await codex.interruptTurn(conv.codexThreadId);
      } else {
        ok = await codex.interruptTurn(threadId);
      }
      return json(res, { ok });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/rename$/) && req.method === "POST") {
      const threadId = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      if (!name) return json(res, { error: "name required" }, 400);
      if (isConv(threadId)) {
        const conv = convStore.get(threadId);
        conv.title = name;
        convStore.save();
        // A Claude conv has no server-side name to set; a Codex-backed one does.
        if (conv.codexThreadId) await codex.renameThread(conv.codexThreadId, name).catch(() => {});
        return json(res, { ok: true, name });
      }
      await codex.renameThread(threadId, name);
      return json(res, { ok: true, name });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/archive$/) && req.method === "POST") {
      const threadId = decodeURIComponent(url.pathname.split("/")[3]);
      if (isConv(threadId)) {
        const conv = convStore.get(threadId);
        if (conv.codexThreadId) await codex.archiveThread(conv.codexThreadId).catch(() => {});
        convStore.remove(threadId);
        return json(res, { ok: true });
      }
      await codex.archiveThread(threadId);
      return json(res, { ok: true });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/compact$/) && req.method === "POST") {
      const threadId = codexThreadIdOf(decodeURIComponent(url.pathname.split("/")[3]));
      await codex.compactThread(threadId);
      return json(res, { ok: true });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/fork$/) && req.method === "POST") {
      const threadId = codexThreadIdOf(decodeURIComponent(url.pathname.split("/")[3]));
      const body = await readJson(req);
      const result = await codex.forkThread(threadId, body.cwd || root);
      return json(res, { thread: normalizeThread(result.thread, false) });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/rollback$/) && req.method === "POST") {
      const threadId = codexThreadIdOf(decodeURIComponent(url.pathname.split("/")[3]));
      const body = await readJson(req);
      await codex.rollbackThread(threadId, Math.max(1, Number(body.numTurns) || 1));
      return json(res, { ok: true });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/steer$/) && req.method === "POST") {
      const threadId = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJson(req);
      const ok = await codex.steerTurn(threadId, String(body.text || ""));
      return json(res, { ok });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/review$/) && req.method === "POST") {
      const threadId = codexThreadIdOf(decodeURIComponent(url.pathname.split("/")[3]));
      await codex.startReview(threadId);
      return json(res, { ok: true });
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/summary$/) && req.method === "GET") {
      const threadId = codexThreadIdOf(decodeURIComponent(url.pathname.split("/")[3]));
      const result = await codex.conversationSummary(threadId);
      return json(res, { summary: result.summary || result });
    }
    if (url.pathname === "/api/search") {
      const term = url.searchParams.get("q") || "";
      if (!term.trim()) return json(res, { threads: [] });
      const result = await codex.searchThreads(term.trim());
      const items = result.data || result.threads || result.results || [];
      return json(res, { threads: items.map((t) => normalizeThread(t.thread || t, false)) });
    }
    if (url.pathname === "/api/skills") {
      const cwd = url.searchParams.get("cwd") || root;
      const result = await codex.listSkills([cwd]);
      const group = (result.data || []).find((g) => g.cwd === cwd) || (result.data || [])[0];
      return json(res, { skills: group?.skills || [] });
    }
    if (url.pathname === "/api/mcp") {
      const result = await codex.listMcpServers();
      const servers = (result.data || []).map((s) => ({
        name: s.name,
        tools: Object.keys(s.tools || {}),
      }));
      return json(res, { servers });
    }
    if (url.pathname === "/api/plugins") {
      const result = await codex.listPlugins();
      const plugins = [];
      for (const mp of result.marketplaces || []) {
        for (const pl of mp.plugins || []) {
          plugins.push({ id: pl.id, marketplace: mp.name, installed: Boolean(pl.installed ?? pl.enabled) });
        }
      }
      return json(res, { plugins });
    }
    if (url.pathname === "/api/files") {
      const query = url.searchParams.get("q") || "";
      const rootDir = url.searchParams.get("root") || root;
      if (!query.trim()) return json(res, { files: [] });
      const result = await codex.fuzzyFiles(query.trim(), [rootDir]);
      return json(res, {
        files: (result.files || []).slice(0, 20).map((f) => ({ path: f.path, name: f.file_name })),
      });
    }
    if (url.pathname === "/api/authstatus") {
      const result = await codex.authStatus();
      return json(res, { authMethod: result.authMethod, requiresOpenaiAuth: result.requiresOpenaiAuth });
    }
    if (url.pathname === "/api/gitdiff") {
      const cwd = url.searchParams.get("cwd") || root;
      try {
        const result = await codex.gitDiff(cwd);
        return json(res, { diff: result.diff || result.sha || "", raw: result });
      } catch (error) {
        return json(res, { diff: "", error: error.message });
      }
    }
    if (url.pathname.match(/^\/api\/threads\/[^/]+\/turns$/) && req.method === "POST") {
      const threadId = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJson(req);
      const settings = sanitizeSettings(body.settings);
      const images = sanitizeImages(body.images);
      if (isConv(threadId)) {
        const conv = convStore.get(threadId);
        const turn = await runConvTurn(conv, body.text, settings);
        return json(res, {
          reply: turn.reply,
          partial: Boolean(turn.partial),
          thread: normalizeConv(conv, true),
          events: codex.eventsFor(threadId),
        });
      }
      codex.addEvent(`api.turn.start: ${threadId}`, threadId);
      codex.assertTurnAvailable(threadId);
      // Resume is best-effort: a freshly started thread has no rollout yet and
      // is already loaded, so a resume failure there must not block the turn.
      await codex.resumeThread(threadId, body.cwd, settings).catch((error) => {
        codex.addEvent(`thread.resume.skipped: ${error.message}`, threadId);
      });
      const turn = await codex.runTurn(threadId, body.text, body.cwd, settings, images);
      const result = await codex.readThread(threadId);
      return json(res, {
        reply: turn.text || latestAgentText(result.thread),
        partial: Boolean(turn.partial),
        thread: normalizeThread(result.thread, true),
        events: codex.eventsFor(threadId),
      });
    }
    return serveStatic(url.pathname, res);
  } catch (error) {
    logToFile("error", `${req.method} ${req.url} → ${error.stack || error.message}`);
    json(res, { error: error.message, events: codex.eventsFor() }, error.statusCode || 500);
  }
});

if (require.main === module) {
  server.listen(port, host, () => {
    console.log(`Codex Web Demo running at http://${host}:${port}/`);
  });
}

module.exports = { CodexAppServer, claudeModel, buildReplayPrompt, migrateConv, switchConvEngine };

function formatNotification(message) {
  const params = message.params || {};
  if (message.method === "error") {
    const suffix = params.willRetry ? " (retrying)" : "";
    return `error: ${params.error?.message || "unknown"}${suffix}`;
  }
  if (message.method === "thread/status/changed") {
    return `thread/status/changed: ${params.status?.type || "unknown"}`;
  }
  if (message.method === "item/started") {
    return `item/started: ${params.item?.type || "item"}`;
  }
  if (message.method === "item/completed") {
    return `item/completed: ${params.item?.type || "item"}`;
  }
  return message.method || "notification";
}

async function syncPayload() {
  // Native Codex threads that a web conversation has adopted — hide them from
  // the list so a switched conversation doesn't appear twice.
  const adopted = new Set(convStore.all().map((c) => c.codexThreadId).filter(Boolean));
  let codexThreads = [];
  let source = "codex-app-server";
  try {
    const result = await codex.listThreads();
    codexThreads = result.data
      .filter((thread) => !adopted.has(thread.id))
      .map((thread) => normalizeThread(thread, false));
  } catch (error) {
    // Codex may be unavailable; still surface stored conversations.
    codex.addEvent(`codex.list.failed: ${error.message}`);
    source = "claude-only";
  }
  // Merge web-created conversations (both engines), newest first.
  const convThreads = convStore
    .all()
    .map((conv) => normalizeConv(conv, false))
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  const threads = [...convThreads, ...codexThreads];
  const projects = normalizeProjects(threads);
  return { source, projects, threads, events: codex.eventsFor(null) };
}

// Resolve a thread id to a Codex native thread id for Codex-only operations.
// Store-managed conversations must have started their Codex session first.
function codexThreadIdOf(id) {
  if (!isConv(id)) return id;
  const conv = convStore.get(id);
  if (conv.engine !== "codex" || !conv.codexThreadId) {
    const error = new Error("请先在该对话发一条消息以建立 Codex 会话");
    error.statusCode = 409;
    throw error;
  }
  return conv.codexThreadId;
}

function normalizeProjects(threads) {
  const byPath = new Map();
  for (const thread of threads) {
    const projectPath = thread.path;
    if (!byPath.has(projectPath)) {
      byPath.set(projectPath, {
        id: projectPath,
        name: path.basename(projectPath) || projectPath,
        path: projectPath,
      });
    }
  }
  if (!byPath.has(root)) {
    byPath.set(root, { id: root, name: path.basename(root), path: root });
  }
  return [...byPath.values()];
}

// Cache inline image data so big base64 payloads aren't re-sent with every
// thread read; messages reference a lightweight /img/<id> URL instead.
const imageStore = new Map();

function externalizeImage(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!match) return dataUrl;
  const id = crypto.createHash("sha1").update(dataUrl).digest("hex").slice(0, 16);
  if (!imageStore.has(id)) {
    imageStore.set(id, { contentType: match[1], buffer: Buffer.from(match[2], "base64") });
    if (imageStore.size > 300) imageStore.delete(imageStore.keys().next().value);
  }
  return `/img/${id}`;
}

function externalizeImages(messages) {
  for (const message of messages) {
    if (Array.isArray(message.images) && message.images.length) {
      message.images = message.images.map(externalizeImage);
    }
  }
  return messages;
}

function normalizeThread(thread, includeMessages) {
  return {
    id: thread.id,
    engine: "codex",
    projectId: thread.cwd,
    title: thread.name || trimPreview(thread.preview) || "未命名对话",
    updatedAt: formatTime(thread.updatedAt),
    path: thread.cwd,
    status: thread.status,
    messages: includeMessages ? externalizeImages(extractMessages(thread)) : [],
  };
}

function extractMessages(thread) {
  const messages = [];
  for (const turn of thread.turns || []) {
    let lastAgent = null;
    for (const item of turn.items || []) {
      const message = itemToMessage(item);
      if (message) {
        messages.push(message);
        if (message.role === "agent") lastAgent = message;
      }
    }
    // Attach turn timing/status to the turn's final agent message.
    if (lastAgent) {
      lastAgent.durationMs = turn.durationMs || null;
      lastAgent.turnStatus = turn.status?.type || turn.status || null;
    }
  }
  if (!messages.length && thread.preview) {
    messages.push({ role: "user", text: thread.preview, images: [] });
  }
  return messages;
}

function latestAgentText(thread) {
  return extractMessages(thread)
    .filter((message) => message.role === "agent")
    .at(-1)?.text || "";
}

function trimPreview(value) {
  return (value || "").replace(/\s+/g, " ").slice(0, 36);
}

function formatTime(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(value));
}

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(root, safePath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
