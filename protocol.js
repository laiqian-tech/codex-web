"use strict";

// Server -> client approval requests that the web client must answer.
// (NEW turn/start API. Legacy execCommandApproval/applyPatchApproval are not
// used because the proxy starts turns via turn/start.)
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

const VALID_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// A JSON-RPC message is either our response (id, no method), a server-initiated
// request (id + method, needs a reply), or a notification (method, no id).
function classifyMessage(message) {
  const hasId = has(message, "id");
  const hasMethod = has(message, "method") && message.method;
  if (hasId && hasMethod) {
    return { kind: "serverRequest", id: message.id, method: message.method };
  }
  if (hasId) {
    return { kind: "response", id: message.id };
  }
  return { kind: "notification", method: message.method };
}

// Trim an approval request down to what the UI needs to render a decision.
function summarizeApproval(method, params = {}) {
  const base = {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    reason: params.reason || null,
  };
  if (method === "item/commandExecution/requestApproval") {
    return {
      ...base,
      kind: "command",
      command: params.command || null,
      cwd: typeof params.cwd === "string" ? params.cwd : params.cwd?.path || null,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return { ...base, kind: "fileChange", grantRoot: params.grantRoot || null };
  }
  return { ...base, kind: "unknown" };
}

// Build the JSON-RPC response payload that answers an approval request.
function buildApprovalResult(id, decision) {
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`invalid approval decision: ${decision}`);
  }
  return { id, result: { decision } };
}

// Route a turn notification to the right pending waiter. An exact turnId match
// always wins. When the incoming turnId is unknown, only fall back to a
// thread-level match if exactly one waiter is on that thread — otherwise the
// routing is ambiguous and we must not guess (prevents concurrent-turn crosstalk).
function matchWaiter(waiters, threadId, turnId) {
  if (turnId) {
    const exact = waiters.find((w) => w.threadId === threadId && w.turnId === turnId);
    if (exact) return exact;
  }
  const onThread = waiters.filter((w) => w.threadId === threadId);
  if (turnId) {
    // turnId known but no waiter has it yet: only the lone, not-yet-identified
    // waiter on this thread can own it.
    const unidentified = onThread.filter((w) => !w.turnId);
    return unidentified.length === 1 ? unidentified[0] : undefined;
  }
  // No turnId on the notification: unambiguous only if a single waiter is on the thread.
  return onThread.length === 1 ? onThread[0] : undefined;
}

// Allowed run-setting values (from the app-server protocol schema).
const SETTING_ENUMS = {
  approvalPolicy: new Set(["untrusted", "on-failure", "on-request", "never"]),
  sandbox: new Set(["read-only", "workspace-write", "danger-full-access"]),
  effort: new Set(["none", "minimal", "low", "medium", "high", "xhigh"]),
};

// Validate UI-supplied run settings, dropping anything not in the schema so we
// never forward junk to app-server.
function sanitizeSettings(input = {}) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const key of Object.keys(SETTING_ENUMS)) {
    if (SETTING_ENUMS[key].has(input[key])) out[key] = input[key];
  }
  if (typeof input.model === "string" && input.model.trim()) out.model = input.model.trim();
  return out;
}

// Accept only inline data:image attachments, capped, so we never forward
// arbitrary URLs or oversized payloads to a turn.
const MAX_IMAGES = 6;
function sanitizeImages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((url) => typeof url === "string" && /^data:image\//i.test(url))
    .slice(0, MAX_IMAGES);
}

module.exports = {
  APPROVAL_METHODS,
  VALID_DECISIONS,
  classifyMessage,
  summarizeApproval,
  buildApprovalResult,
  matchWaiter,
  sanitizeSettings,
  SETTING_ENUMS,
  sanitizeImages,
};
