"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { claudeModel, buildReplayPrompt, normalizeClaudeConv } = require("../server");

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
  assert.ok(buildReplayPrompt(long).length <= 12000);
});

test("normalizeClaudeConv reports notLoaded before the first turn, idle after", () => {
  const fresh = normalizeClaudeConv(
    { id: "claude-1", cwd: "/repo", title: "新对话", updatedAt: 0, nativeId: null, messages: [] },
    false,
  );
  assert.equal(fresh.engine, "claude");
  assert.equal(fresh.status.type, "notLoaded");
  assert.deepEqual(fresh.messages, []);

  const live = normalizeClaudeConv(
    { id: "claude-1", cwd: "/repo", title: "t", updatedAt: 0, nativeId: "sess", messages: [{ role: "user", text: "hi", images: [] }] },
    true,
  );
  assert.equal(live.status.type, "idle");
  assert.equal(live.messages.length, 1);
});

test("normalizeClaudeConv omits messages when includeMessages is false", () => {
  const conv = normalizeClaudeConv(
    { id: "c", cwd: "/r", title: "t", updatedAt: 0, nativeId: "s", messages: [{ role: "user", text: "hi" }] },
    false,
  );
  assert.deepEqual(conv.messages, []);
});
