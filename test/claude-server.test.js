"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { claudeModel, buildReplayPrompt, migrateConv, switchConvEngine } = require("../server");

test("claudeModel forwards Claude ids and aliases, drops Codex ids", () => {
  assert.equal(claudeModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(claudeModel("opus"), "opus"); // latest-tracking alias
  assert.equal(claudeModel("sonnet"), "sonnet");
  assert.equal(claudeModel("haiku"), "haiku");
  assert.equal(claudeModel("gpt-5-codex"), undefined); // a Codex model must not leak to Claude
  assert.equal(claudeModel(""), undefined);
  assert.equal(claudeModel(undefined), undefined);
});

test("buildReplayPrompt flattens user/agent turns into seed context", () => {
  const prompt = buildReplayPrompt([
    { role: "user", text: "建个登录页" },
    { role: "event", kind: "command", command: "ls" }, // events are skipped
    { role: "agent", text: "已建好 login.html" },
  ]);
  assert.match(prompt, /此前对话/);
  assert.match(prompt, /【我】建个登录页/);
  assert.match(prompt, /【助手】已建好 login\.html/);
  assert.ok(!prompt.includes("ls"), "tool events should not appear in the replay");
});

test("buildReplayPrompt caps length", () => {
  const long = [{ role: "user", text: "x".repeat(50000) }];
  assert.ok(buildReplayPrompt(long).length <= 6000);
});

test("buildReplayPrompt keeps only the most recent turns", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: "user", text: `msg${i}` }));
  const prompt = buildReplayPrompt(many);
  assert.ok(!prompt.includes("msg0\n") && !prompt.includes("msg5"), "drops old turns");
  assert.match(prompt, /msg29/); // keeps the latest
});

test("migrateConv upgrades an old Claude-only record to the dual-engine shape", () => {
  const conv = migrateConv({ id: "claude-1", engine: "claude", nativeId: "sess-abc", cwd: "/r", title: "t", messages: [{ role: "user", text: "hi" }] });
  assert.equal(conv.engine, "claude");
  assert.equal(conv.claudeSessionId, "sess-abc"); // nativeId → claudeSessionId
  assert.equal(conv.codexThreadId, null);
  assert.deepEqual(conv.engineCursor, {});
  assert.equal(conv.messages.length, 1);
});

test("migrateConv defaults a new dual-engine record cleanly", () => {
  const conv = migrateConv({ id: "conv-1", engine: "codex", codexThreadId: "t1", cwd: "/r" });
  assert.equal(conv.codexThreadId, "t1");
  assert.equal(conv.claudeSessionId, null);
  assert.deepEqual(conv.messages, []);
});

test("switchConvEngine flips engine, seeds full recent context on first switch", () => {
  const conv = {
    engine: "codex", codexThreadId: "t1", claudeSessionId: null,
    messages: [{ role: "user", text: "建登录页" }, { role: "agent", text: "好的，已建好" }],
    engineCursor: {}, pendingSeed: null,
  };
  switchConvEngine(conv, "claude");
  assert.equal(conv.engine, "claude");
  assert.equal(conv.engineCursor.codex, 2, "marks where we left codex");
  assert.match(conv.pendingSeed, /建登录页/); // first switch carries the history
});

test("switchConvEngine on switch-back replays only the delta since it last ran", () => {
  const conv = {
    engine: "codex", codexThreadId: "t1", claudeSessionId: "s1",
    messages: [
      { role: "user", text: "A" }, { role: "agent", text: "a" }, // codex ran these
      { role: "user", text: "B" }, { role: "agent", text: "b" }, // claude ran these
    ],
    engineCursor: { claude: 2 }, // claude last left after 2 messages
    pendingSeed: null,
  };
  // currently on codex; switch to claude → claude should only need B/b (the delta).
  switchConvEngine(conv, "claude");
  assert.equal(conv.engine, "claude");
  assert.match(conv.pendingSeed, /B/);
  assert.ok(!conv.pendingSeed.includes("【我】A"), "old turns claude already saw are not replayed");
});

test("switchConvEngine to the same engine is a no-op (no seed)", () => {
  const conv = { engine: "claude", messages: [{ role: "user", text: "x" }], engineCursor: {}, pendingSeed: null };
  switchConvEngine(conv, "claude");
  assert.equal(conv.pendingSeed, null);
});
