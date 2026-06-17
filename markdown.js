"use strict";

// Minimal, XSS-safe Markdown renderer (no dependencies). Strategy: pull out
// fenced code first, escape everything, then apply a small set of block/inline
// rules. Agent output is untrusted, so escaping happens before any markup.
(function (root) {
  // Private-use sentinels so placeholders never collide with real text/digits.
  const OPEN = String.fromCharCode(0xe000);
  const CLOSE = String.fromCharCode(0xe001);

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  const SAFE_URL = /^(https?:\/\/|mailto:)/i;

  function renderInline(text) {
    // text is already HTML-escaped here.
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `${OPEN}${codes.length - 1}${CLOSE}`;
    });

    // links [text](url) — validate scheme; unescape &amp; in the url only.
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
      const raw = url.replace(/&amp;/g, "&");
      if (!SAFE_URL.test(raw)) return label;
      return `<a href="${escapeHtml(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    s = s.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_, i) => codes[Number(i)]);
    return s;
  }

  function renderMarkdown(input) {
    const blocks = [];
    let text = String(input == null ? "" : input).replace(/\r\n/g, "\n");

    // 1) fenced code blocks → placeholders (content escaped, not parsed).
    text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, body) => {
      const cls = lang.trim() ? ` class="lang-${escapeHtml(lang.trim())}"` : "";
      blocks.push(`<pre><code${cls}>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`);
      return `\n${OPEN}${blocks.length - 1}${CLOSE}\n`;
    });

    // 2) escape remaining text, then walk lines for block structure.
    const lines = escapeHtml(text).split("\n");
    const html = [];
    let list = null; // { type: 'ul'|'ol', items: [] }

    const flushList = () => {
      if (!list) return;
      html.push(`<${list.type}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${list.type}>`);
      list = null;
    };

    const codeLine = new RegExp(`^${OPEN}(\\d+)${CLOSE}$`);
    for (const line of lines) {
      const code = line.match(codeLine);
      if (code) {
        flushList();
        html.push(blocks[Number(code[1])]);
        continue;
      }
      if (!line.trim()) {
        flushList();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushList();
        const level = heading[1].length;
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        const type = ul ? "ul" : "ol";
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [] };
        }
        list.items.push((ul || ol)[1]);
        continue;
      }
      const quote = line.match(/^&gt;\s?(.*)$/);
      if (quote) {
        flushList();
        html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
        continue;
      }
      flushList();
      html.push(`<p>${renderInline(line)}</p>`);
    }
    flushList();
    return html.join("\n");
  }

  const api = { renderMarkdown, escapeHtml };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CodexMarkdown = api;
})(typeof window !== "undefined" ? window : null);
