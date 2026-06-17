const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexAppServer } = require("../server");

function makeServer() {
  const codex = new CodexAppServer();
  const writes = [];
  codex.proc = { killed: false, stdin: { write: (s) => writes.push(s) } };
  return { codex, writes };
}

function lastJson(writes) {
  return JSON.parse(writes.at(-1));
}

test("approval request is queued, not mistaken for a response, and not auto-answered", () => {
  const { codex, writes } = makeServer();
  codex.handleLine(
    JSON.stringify({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t", turnId: "u", itemId: "i", command: "ls -la", cwd: "/repo" },
    }),
  );
  const pending = codex.pendingApprovals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "42");
  assert.equal(pending[0].summary.command, "ls -la");
  // Critical: the proxy must NOT write a reply automatically (no hang, no silent accept).
  assert.equal(writes.length, 0);
});

test("respondApproval writes a JSON-RPC result and clears the queue", () => {
  const { codex, writes } = makeServer();
  codex.handleLine(
    JSON.stringify({
      id: 42,
      method: "item/fileChange/requestApproval",
      params: { threadId: "t", turnId: "u", itemId: "i", reason: "outside workspace" },
    }),
  );
  const ok = codex.respondApproval("42", "accept");
  assert.equal(ok, true);
  assert.deepEqual(lastJson(writes), { id: 42, result: { decision: "accept" } });
  assert.equal(codex.pendingApprovals().length, 0);
});

test("respondApproval on unknown id returns false", () => {
  const { codex } = makeServer();
  assert.equal(codex.respondApproval("nope", "accept"), false);
});

test("unhandled server request gets an error reply so the turn does not hang", () => {
  const { codex, writes } = makeServer();
  codex.handleLine(JSON.stringify({ id: 7, method: "attestation/generate", params: {} }));
  const reply = lastJson(writes);
  assert.equal(reply.id, 7);
  assert.equal(reply.error.code, -32601);
});

test("stream subscribers receive deltas for their thread only", () => {
  const { codex } = makeServer();
  const a = [];
  const b = [];
  const resA = { write: (s) => a.push(s), end: () => {} };
  const resB = { write: (s) => b.push(s), end: () => {} };
  codex.addStreamSubscriber(resA, "t1");
  codex.addStreamSubscriber(resB, "t2");
  codex.handleLine(
    JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "u1", delta: "Hi" } }),
  );
  assert.ok(a.some((s) => s.includes('"delta":"Hi"')));
  assert.equal(b.length, 0); // t2 subscriber must not see t1's delta
});

test("removing a stream subscriber stops delivery", () => {
  const { codex } = makeServer();
  const a = [];
  const res = { write: (s) => a.push(s), end: () => {} };
  const off = codex.addStreamSubscriber(res, "t1");
  off();
  codex.handleLine(
    JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "u1", delta: "X" } }),
  );
  assert.equal(a.length, 0);
});

test("interruptTurn sends turn/interrupt for the active turn", () => {
  const { codex, writes } = makeServer();
  codex.turnWaiters.push({ threadId: "t1", turnId: "u9" });
  codex.interruptTurn("t1");
  const sent = JSON.parse(writes.find((w) => w.includes("turn/interrupt")));
  assert.equal(sent.method, "turn/interrupt");
  assert.deepEqual(sent.params, { threadId: "t1", turnId: "u9" });
});

test("interruptTurn returns false when there is no active turn", async () => {
  const { codex } = makeServer();
  assert.equal(await codex.interruptTurn("t1"), false);
});

test("hasActiveTurn detects an in-flight web turn on the same thread", () => {
  const { codex } = makeServer();
  codex.turnWaiters.push({ threadId: "t1", turnId: "u1" });
  assert.equal(codex.hasActiveTurn("t1"), true);
  assert.equal(codex.hasActiveTurn("t2"), false);
});

test("assertTurnAvailable rejects before a duplicate turn can resume the thread", () => {
  const { codex } = makeServer();
  codex.activeTurns.add("t1");
  assert.throws(() => codex.assertTurnAvailable("t1"), /turn already running/);
  assert.doesNotThrow(() => codex.assertTurnAvailable("t2"));
});

test("active turn remains guarded until turn/completed", () => {
  const { codex } = makeServer();
  codex.handleNotification({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } });
  assert.equal(codex.hasActiveTurn("t1"), true);
  codex.handleNotification({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1" } } });
  assert.equal(codex.hasActiveTurn("t1"), false);
});

test("a terminal error clears active turn state even after the waiter is gone", () => {
  const { codex } = makeServer();
  codex.activeTurns.add("t1");
  codex.handleNotification({
    method: "error",
    params: { threadId: "t1", turnId: "u1", willRetry: false, error: { message: "failed" } },
  });
  assert.equal(codex.hasActiveTurn("t1"), false);
});

test("eventsFor isolates per-thread events but keeps system events visible", () => {
  const { codex } = makeServer();
  codex.addEvent("codex.ready"); // system (null)
  codex.addEvent("turn started", "thread-A");
  codex.addEvent("turn started", "thread-B");
  const a = codex.eventsFor("thread-A");
  assert.ok(a.some((e) => e.includes("codex.ready")), "system event visible");
  assert.ok(a.some((e) => e.endsWith("turn started")), "own thread event visible");
  // thread-A must NOT see thread-B's activity
  const b = codex.eventsFor("thread-B");
  assert.equal(a.filter((e) => e.includes("turn started")).length, 1);
  assert.equal(b.filter((e) => e.includes("turn started")).length, 1);
  // no filter returns everything
  assert.equal(codex.eventsFor().filter((e) => e.includes("turn started")).length, 2);
});

test("normal responses still resolve pending requests", async () => {
  const { codex } = makeServer();
  const p = new Promise((resolve) => codex.pending.set(5, { resolve, reject: () => {} }));
  codex.handleLine(JSON.stringify({ id: 5, result: { ok: 1 } }));
  assert.deepEqual(await p, { ok: 1 });
});
