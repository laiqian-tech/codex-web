const test = require("node:test");
const assert = require("node:assert/strict");
const { itemToMessage } = require("../transcript");

test("userMessage: text + images", () => {
  const m = itemToMessage({
    type: "userMessage",
    content: [
      { type: "text", text: "hi" },
      { type: "image", url: "data:image/png;base64,AAA" },
    ],
  });
  assert.equal(m.role, "user");
  assert.equal(m.text, "hi");
  assert.deepEqual(m.images, ["data:image/png;base64,AAA"]);
});

test("agentMessage: text", () => {
  const m = itemToMessage({ type: "agentMessage", text: "done" });
  assert.deepEqual(m, { role: "agent", text: "done", images: [] });
});

test("agentMessage: empty text is skipped", () => {
  assert.equal(itemToMessage({ type: "agentMessage", text: "  " }), null);
});

test("fileChange: path, change kind, and diff line counts", () => {
  const m = itemToMessage({
    type: "fileChange",
    changes: [
      { path: "/repo/a.js", kind: { type: "update" }, diff: "+added\n-removed\n unchanged\n+more" },
    ],
  });
  assert.equal(m.role, "event");
  assert.equal(m.kind, "fileChange");
  assert.equal(m.files[0].path, "/repo/a.js");
  assert.equal(m.files[0].change, "update");
  assert.equal(m.files[0].additions, 2);
  assert.equal(m.files[0].deletions, 1);
});

test("webSearch: collects queries", () => {
  const m = itemToMessage({
    type: "webSearch",
    query: "x",
    action: { type: "search", queries: ["a", "b"] },
  });
  assert.equal(m.kind, "webSearch");
  assert.deepEqual(m.queries, ["a", "b"]);
});

test("webSearch: falls back to top-level query when no queries array", () => {
  const m = itemToMessage({ type: "webSearch", query: "solo", action: { type: "search" } });
  assert.deepEqual(m.queries, ["solo"]);
});

test("mcpToolCall: server/tool/status/title", () => {
  const m = itemToMessage({
    type: "mcpToolCall",
    server: "node_repl",
    tool: "js",
    status: "completed",
    durationMs: 1200,
    title: "run code",
  });
  assert.equal(m.kind, "tool");
  assert.equal(m.server, "node_repl");
  assert.equal(m.tool, "js");
  assert.equal(m.status, "completed");
  assert.equal(m.title, "run code");
});

test("contextCompaction maps to a compaction event", () => {
  assert.equal(itemToMessage({ type: "contextCompaction" }).kind, "compaction");
});

test("commandExecution: command, exit code, output", () => {
  const m = itemToMessage({
    type: "commandExecution",
    command: "/bin/zsh -lc 'ls -1'",
    status: "completed",
    exitCode: 0,
    durationMs: 120,
    aggregatedOutput: "a.js\nb.js\n",
  });
  assert.equal(m.kind, "command");
  assert.equal(m.command, "/bin/zsh -lc 'ls -1'");
  assert.equal(m.exitCode, 0);
  assert.equal(m.output, "a.js\nb.js\n");
});

test("reasoning: joins summary/content text", () => {
  const m = itemToMessage({
    type: "reasoning",
    summary: [{ type: "text", text: "Plan: list files" }],
    content: [{ type: "text", text: "Then summarize" }],
  });
  assert.equal(m.kind, "reasoning");
  assert.match(m.text, /Plan: list files/);
  assert.match(m.text, /Then summarize/);
});

test("reasoning with no text is skipped", () => {
  assert.equal(itemToMessage({ type: "reasoning", summary: [], content: [] }), null);
});

test("unknown item types are skipped", () => {
  assert.equal(itemToMessage({ type: "somethingNew" }), null);
});
