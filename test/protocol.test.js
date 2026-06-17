const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyMessage,
  summarizeApproval,
  buildApprovalResult,
  APPROVAL_METHODS,
} = require("../protocol");

const { matchWaiter } = require("../protocol");

test("matchWaiter: exact turnId match wins even with multiple waiters", () => {
  const a = { threadId: "t1", turnId: "u1" };
  const b = { threadId: "t1", turnId: "u2" };
  assert.equal(matchWaiter([a, b], "t1", "u2"), b);
});

test("matchWaiter: unknown turnId on the only waiter for the thread falls back to thread match", () => {
  const a = { threadId: "t1", turnId: null };
  assert.equal(matchWaiter([a], "t1", "u1"), a);
});

test("matchWaiter: multiple waiters on a thread with no exact turnId → no match (avoid misrouting)", () => {
  const a = { threadId: "t1", turnId: null };
  const b = { threadId: "t1", turnId: "u2" };
  // incoming notification has no turnId; ambiguous → must not guess
  assert.equal(matchWaiter([a, b], "t1", null), undefined);
});

test("matchWaiter: different thread never matches", () => {
  const a = { threadId: "t1", turnId: "u1" };
  assert.equal(matchWaiter([a], "t2", "u1"), undefined);
});

const { sanitizeSettings } = require("../protocol");

test("sanitizeSettings: keeps valid enum values and model string", () => {
  const s = sanitizeSettings({
    approvalPolicy: "never",
    sandbox: "read-only",
    effort: "high",
    model: "gpt-5.5",
  });
  assert.deepEqual(s, { approvalPolicy: "never", sandbox: "read-only", effort: "high", model: "gpt-5.5" });
});

test("sanitizeSettings: drops invalid enum values", () => {
  const s = sanitizeSettings({ approvalPolicy: "hack", sandbox: "wide-open", effort: "ultra" });
  assert.deepEqual(s, {});
});

test("sanitizeSettings: ignores empty/non-string model", () => {
  assert.equal(sanitizeSettings({ model: "   " }).model, undefined);
  assert.equal(sanitizeSettings({ model: 123 }).model, undefined);
});

test("sanitizeSettings: tolerates missing/empty input", () => {
  assert.deepEqual(sanitizeSettings(), {});
  assert.deepEqual(sanitizeSettings(null), {});
});

const { sanitizeImages } = require("../protocol");

test("sanitizeImages: keeps data:image URLs only", () => {
  const out = sanitizeImages([
    "data:image/png;base64,AAA",
    "https://evil.example/x.png",
    "javascript:alert(1)",
    "data:text/html,<script>",
  ]);
  assert.deepEqual(out, ["data:image/png;base64,AAA"]);
});

test("sanitizeImages: caps the number of images", () => {
  const many = Array.from({ length: 20 }, (_, i) => `data:image/png;base64,${i}`);
  assert.equal(sanitizeImages(many).length, 6);
});

test("sanitizeImages: tolerates non-array input", () => {
  assert.deepEqual(sanitizeImages(null), []);
  assert.deepEqual(sanitizeImages("nope"), []);
});

test("classifyMessage: response has id but no method", () => {
  assert.deepEqual(classifyMessage({ id: 7, result: {} }), { kind: "response", id: 7 });
});

test("classifyMessage: server-initiated request has both id and method", () => {
  const msg = { id: 9, method: "item/commandExecution/requestApproval", params: {} };
  assert.deepEqual(classifyMessage(msg), {
    kind: "serverRequest",
    id: 9,
    method: "item/commandExecution/requestApproval",
  });
});

test("classifyMessage: notification has method but no id", () => {
  assert.deepEqual(classifyMessage({ method: "turn/completed", params: {} }), {
    kind: "notification",
    method: "turn/completed",
  });
});

test("classifyMessage: id of 0 is still treated as a real id", () => {
  assert.equal(classifyMessage({ id: 0, result: {} }).kind, "response");
});

test("APPROVAL_METHODS covers command and file-change approvals", () => {
  assert.ok(APPROVAL_METHODS.has("item/commandExecution/requestApproval"));
  assert.ok(APPROVAL_METHODS.has("item/fileChange/requestApproval"));
});

test("summarizeApproval: command approval extracts command/cwd/reason", () => {
  const s = summarizeApproval("item/commandExecution/requestApproval", {
    threadId: "t1",
    turnId: "u1",
    itemId: "i1",
    command: "rm -rf build",
    cwd: "/repo",
    reason: "outside sandbox",
  });
  assert.equal(s.kind, "command");
  assert.equal(s.command, "rm -rf build");
  assert.equal(s.cwd, "/repo");
  assert.equal(s.reason, "outside sandbox");
});

test("summarizeApproval: file change approval", () => {
  const s = summarizeApproval("item/fileChange/requestApproval", {
    threadId: "t1",
    turnId: "u1",
    itemId: "i2",
    reason: "write outside workspace",
    grantRoot: "/repo",
  });
  assert.equal(s.kind, "fileChange");
  assert.equal(s.reason, "write outside workspace");
  assert.equal(s.grantRoot, "/repo");
});

test("buildApprovalResult: wraps decision into JSON-RPC result for a request id", () => {
  assert.deepEqual(buildApprovalResult(12, "accept"), {
    id: 12,
    result: { decision: "accept" },
  });
});

test("buildApprovalResult: rejects unknown decisions", () => {
  assert.throws(() => buildApprovalResult(1, "yolo"));
});

test("buildApprovalResult: accepts all valid decisions", () => {
  for (const d of ["accept", "acceptForSession", "decline", "cancel"]) {
    assert.equal(buildApprovalResult(1, d).result.decision, d);
  }
});
