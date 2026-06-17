const test = require("node:test");
const assert = require("node:assert/strict");
const { renderMarkdown } = require("../markdown");

test("escapes raw HTML so agent output cannot inject markup", () => {
  const out = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("renders fenced code blocks with escaped content", () => {
  const out = renderMarkdown("```js\nconst x = 1 < 2;\n```");
  assert.match(out, /<pre><code[^>]*>[\s\S]*const x = 1 &lt; 2;[\s\S]*<\/code><\/pre>/);
});

test("inline code", () => {
  assert.match(renderMarkdown("use `npm test` now"), /<code>npm test<\/code>/);
});

test("bold and italic", () => {
  assert.match(renderMarkdown("**bold**"), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown("*it*"), /<em>it<\/em>/);
});

test("headings", () => {
  assert.match(renderMarkdown("# Title"), /<h1>Title<\/h1>/);
  assert.match(renderMarkdown("### Sub"), /<h3>Sub<\/h3>/);
});

test("unordered and ordered lists", () => {
  assert.match(renderMarkdown("- a\n- b"), /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
  assert.match(renderMarkdown("1. one\n2. two"), /<ol>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ol>/);
});

test("safe links only (http/https/mailto), with noopener", () => {
  const out = renderMarkdown("[site](https://example.com)");
  assert.match(out, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">site<\/a>/);
});

test("blocks javascript: and other dangerous link schemes", () => {
  const out = renderMarkdown("[x](javascript:alert(1))");
  assert.ok(!out.includes("href=\"javascript"));
  assert.ok(out.includes("x")); // text preserved, just not linked
});

test("code block content is not treated as markdown", () => {
  const out = renderMarkdown("```\n**not bold**\n```");
  assert.ok(out.includes("**not bold**"));
  assert.ok(!out.includes("<strong>"));
});

test("plain paragraphs preserved", () => {
  const out = renderMarkdown("hello world");
  assert.match(out, /hello world/);
});

test("digits in normal text are not clobbered by code placeholders", () => {
  const out = renderMarkdown("I ran `npm test` and 5 of 12 passed");
  assert.match(out, /<code>npm test<\/code>/);
  assert.match(out, /5 of 12 passed/);
  assert.ok(!out.includes("undefined"));
});
