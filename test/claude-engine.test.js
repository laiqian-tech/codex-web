"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeClaudeEvent, toolUseToItem, buildArgs } = require("../claude-engine");

test("init event yields the session id", () => {
  const out = normalizeClaudeEvent({ type: "system", subtype: "init", session_id: "abc-123" });
  assert.deepEqual(out, [{ type: "session", sessionId: "abc-123" }]);
});

test("stream_event text_delta yields a delta", () => {
  const out = normalizeClaudeEvent({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } },
  });
  assert.deepEqual(out, [{ type: "delta", delta: "你好" }]);
});

test("assistant text blocks are not re-emitted (deltas + result own the text)", () => {
  const out = normalizeClaudeEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  assert.deepEqual(out, []);
});

test("assistant Bash tool_use maps to a command event", () => {
  const out = normalizeClaudeEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "item");
  assert.equal(out[0].item.kind, "command");
  assert.equal(out[0].item.command, "ls -la");
  assert.equal(out[0].item._toolUseId, "t1");
});

test("Write tool_use maps to a fileChange add", () => {
  const item = toolUseToItem({ id: "w1", name: "Write", input: { file_path: "/x/y.js" } });
  assert.equal(item.kind, "fileChange");
  assert.equal(item.files[0].path, "/x/y.js");
  assert.equal(item.files[0].change, "add");
});

test("Edit tool_use maps to a fileChange update", () => {
  const item = toolUseToItem({ id: "e1", name: "Edit", input: { file_path: "/x/y.js" } });
  assert.equal(item.files[0].change, "update");
});

test("unknown tool maps to a generic tool event with a title", () => {
  const item = toolUseToItem({ id: "g1", name: "Grep", input: { pattern: "foo" } });
  assert.equal(item.kind, "tool");
  assert.equal(item.tool, "Grep");
  assert.equal(item.title, "foo");
});

test("tool_result is surfaced for the engine to attach", () => {
  const out = normalizeClaudeEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done", is_error: false }] },
  });
  assert.deepEqual(out, [{ type: "toolResult", toolUseId: "t1", output: "done", isError: false }]);
});

test("result success yields the final reply text plus duration/cost", () => {
  const out = normalizeClaudeEvent({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "最终回复",
    duration_ms: 12300,
    total_cost_usd: 0.0123,
  });
  assert.deepEqual(out, [{ type: "result", text: "最终回复", durationMs: 12300, costUsd: 0.0123 }]);
});

test("result success without metrics defaults duration/cost to null", () => {
  const out = normalizeClaudeEvent({ type: "result", is_error: false, result: "hi" });
  assert.deepEqual(out, [{ type: "result", text: "hi", durationMs: null, costUsd: null }]);
});

test("result error yields an error", () => {
  const out = normalizeClaudeEvent({ type: "result", is_error: true, result: "boom" });
  assert.deepEqual(out, [{ type: "error", message: "boom" }]);
});

test("rate_limit_event with info surfaces the rolling window", () => {
  const info = { status: "allowed", resetsAt: 1781768400, rateLimitType: "five_hour" };
  assert.deepEqual(normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: info }), [
    { type: "rateLimit", info },
  ]);
});

test("rate_limit_event without info and unknown events are ignored", () => {
  assert.deepEqual(normalizeClaudeEvent({ type: "rate_limit_event" }), []);
  assert.deepEqual(normalizeClaudeEvent({ type: "whatever" }), []);
  assert.deepEqual(normalizeClaudeEvent(null), []);
});

test("buildArgs includes resume + model when given", () => {
  const args = buildArgs("hi", { sessionId: "s1", model: "claude-sonnet-4-6" });
  assert.ok(args.includes("--resume"));
  assert.ok(args.includes("s1"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("claude-sonnet-4-6"));
  assert.ok(args.includes("stream-json"));
  assert.equal(args[1], "hi");
});

test("buildArgs omits resume on the first turn", () => {
  const args = buildArgs("hi", {});
  assert.ok(!args.includes("--resume"));
  assert.equal(args.at(-1), "acceptEdits");
});
