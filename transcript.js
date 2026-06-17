"use strict";

// Convert a Codex thread item into a renderable transcript message, or null to
// skip it. Keeps the proxy and tests in sync on the item->message mapping.

function userMessage(item) {
  const texts = [];
  const images = [];
  for (const part of item.content || []) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "image" && part.url) images.push(part.url);
    else texts.push(`[${part.type}]`);
  }
  const text = texts.join("\n").trim();
  if (!text && !images.length) return null;
  return { role: "user", text, images };
}

function countDiff(diff = "") {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function fileChange(item) {
  const files = (item.changes || []).map((change) => ({
    path: change.path,
    change: change.kind?.type || "update",
    ...countDiff(change.diff),
    diff: change.diff || "",
  }));
  return { role: "event", kind: "fileChange", files };
}

function webSearch(item) {
  const queries = item.action?.queries?.length
    ? item.action.queries
    : [item.action?.query || item.query].filter(Boolean);
  return { role: "event", kind: "webSearch", queries };
}

function mcpToolCall(item) {
  return {
    role: "event",
    kind: "tool",
    server: item.server || null,
    tool: item.tool || null,
    status: item.status || null,
    durationMs: item.durationMs || null,
    title: item.title || null,
  };
}

function collectText(nodes) {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((n) => (typeof n === "string" ? n : n?.text || ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function commandExecution(item) {
  return {
    role: "event",
    kind: "command",
    command: item.command || "",
    status: item.status || null,
    exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    durationMs: item.durationMs || null,
    output: item.aggregatedOutput || "",
  };
}

function reasoning(item) {
  const text = [collectText(item.summary), collectText(item.content)].filter(Boolean).join("\n");
  return text ? { role: "event", kind: "reasoning", text } : null;
}

function itemToMessage(item) {
  switch (item.type) {
    case "userMessage":
      return userMessage(item);
    case "agentMessage":
      return item.text && item.text.trim()
        ? { role: "agent", text: item.text.trim(), images: [] }
        : null;
    case "fileChange":
      return fileChange(item);
    case "webSearch":
      return webSearch(item);
    case "mcpToolCall":
      return mcpToolCall(item);
    case "imageGeneration":
      return { role: "event", kind: "image", images: item.images || [] };
    case "contextCompaction":
      return { role: "event", kind: "compaction" };
    case "commandExecution":
      return commandExecution(item);
    case "reasoning":
      return reasoning(item);
    default:
      return null;
  }
}

module.exports = { itemToMessage, countDiff };
