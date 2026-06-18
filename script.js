const storageKey = "codex-web-demo-state";

// Register the PWA service worker for installability + offline shell.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* SW optional */
    });
  });
}

const seedState = {
  selectedProjectId: "p1",
  selectedThreadId: "t1",
  projects: [
    {
      id: "p1",
      name: "codex-app",
      path: "/Users/macbook/Documents/codex-app",
    },
    {
      id: "p2",
      name: "nova-web",
      path: "/Users/macbook/Documents/work/nova-web",
    },
  ],
  threads: [
    {
      id: "t1",
      projectId: "p1",
      title: "网页版 Codex demo",
      updatedAt: "刚刚",
      messages: [
        {
          role: "agent",
          text: "这是最小 demo：左侧同步项目和对话，中间继续线程，右侧看 app-server 事件流。",
        },
      ],
    },
    {
      id: "t2",
      projectId: "p1",
      title: "接入 app-server 计划",
      updatedAt: "今天",
      messages: [
        {
          role: "user",
          text: "怎么把 Mac 客户端的项目和线程同步到网页？",
        },
        {
          role: "agent",
          text: "用后端代理连接 codex app-server，不让手机端直接访问本机 Codex 服务。",
        },
      ],
    },
    {
      id: "t3",
      projectId: "p2",
      title: "Review 当前 diff",
      updatedAt: "昨天",
      messages: [
        {
          role: "agent",
          text: "等待连接真实 Codex 后端后，这里可以继续已有 threadId。",
        },
      ],
    },
  ],
  events: [
    "demo.ready: 已加载本地 mock 项目和线程",
    "sync.pending: 等待后端代理接入 codex app-server",
  ],
};

let state = loadState();
let ui = {
  projectSearch: "",
  threadSearch: "",
  dataSource: "Mock",
};

const projectList = document.querySelector("#projectList");
const threadList = document.querySelector("#threadList");
const messageList = document.querySelector("#messageList");
const threadTitle = document.querySelector("#threadTitle");
const threadMeta = document.querySelector("#threadMeta");
const currentProjectPath = document.querySelector("#currentProjectPath");
const eventList = document.querySelector("#eventList");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#promptInput");
const sendButton = composer.querySelector('button[type="submit"]');
const connectionStatus = document.querySelector("#connectionStatus");
// Status text + a tone attribute; on phones the pill renders as a colored dot
// (green = live backend, amber = mock, pulsing grey = busy).
function setConnStatus(text) {
  connectionStatus.textContent = text;
  connectionStatus.dataset.tone = /真实数据|后端在线/.test(text)
    ? "ok"
    : /Mock/.test(text)
      ? "warn"
      : "busy";
}
setConnStatus(connectionStatus.textContent.trim());
// On phones the dot has no room for text — tap it for the details.
connectionStatus.addEventListener("click", () => {
  showInfo(
    "连接状态",
    `<div class="info-item"><strong>${escapeHtml(connectionStatus.textContent)}</strong>
     <p>数据来源：${escapeHtml(ui.dataSource)} · 后端：${escapeHtml(apiBase())}</p></div>`,
  );
});
const backendUrl = document.querySelector("#backendUrl");
const backendStorageKey = "codex-web-demo-backend";
// Default the backend to whatever origin served the page, so the same build
// works from localhost on the desktop and from the LAN IP on a phone.
backendUrl.value = localStorage.getItem(backendStorageKey) || window.location.origin;
backendUrl.addEventListener("change", () =>
  localStorage.setItem(backendStorageKey, backendUrl.value.trim()),
);
const settingsControls = {
  model: document.querySelector("#setModel"),
  effort: document.querySelector("#setEffort"),
  approvalPolicy: document.querySelector("#setApproval"),
  sandbox: document.querySelector("#setSandbox"),
};
const settingsStorageKey = "codex-web-demo-settings";

// The model dropdown is engine-aware: Codex threads list /api/models; Claude
// threads list curated aliases ('opus'/'sonnet'/'haiku', which always track the
// latest). The chosen model is remembered per engine so switching threads keeps
// both selections.
const CLAUDE_MODELS = [
  { id: "", displayName: "默认" },
  { id: "opus", displayName: "Opus（最强）" },
  { id: "sonnet", displayName: "Sonnet（均衡）" },
  { id: "haiku", displayName: "Haiku（最快）" },
];
let codexModels = [{ id: "", displayName: "默认" }];
const modelByEngine = { codex: "", claude: "" };

loadSettings();
Object.values(settingsControls).forEach((el) =>
  el.addEventListener("change", () => {
    if (el === settingsControls.model) modelByEngine[activeEngine()] = el.value;
    localStorage.setItem(settingsStorageKey, JSON.stringify(persistableSettings()));
  }),
);

function activeEngine() {
  return currentThread()?.engine === "claude" ? "claude" : "codex";
}

// Settings sent with a turn: model = the active engine's remembered choice.
function currentSettings() {
  const s = {};
  const model = modelByEngine[activeEngine()];
  if (model) s.model = model;
  for (const key of ["effort", "approvalPolicy", "sandbox"]) {
    if (settingsControls[key].value) s[key] = settingsControls[key].value;
  }
  return s;
}

function persistableSettings() {
  return {
    model: modelByEngine.codex,
    claudeModel: modelByEngine.claude,
    effort: settingsControls.effort.value,
    approvalPolicy: settingsControls.approvalPolicy.value,
    sandbox: settingsControls.sandbox.value,
  };
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsStorageKey)) || {};
    modelByEngine.codex = saved.model || "";
    modelByEngine.claude = saved.claudeModel || "";
    for (const key of ["effort", "approvalPolicy", "sandbox"]) {
      if (saved[key]) settingsControls[key].value = saved[key];
    }
  } catch {
    // ignore malformed settings
  }
}

// Fill the model dropdown for the active engine and restore its saved choice.
function refreshModelOptions() {
  const engine = activeEngine();
  const list = engine === "claude" ? CLAUDE_MODELS : codexModels;
  const select = settingsControls.model;
  select.innerHTML = "";
  for (const m of list) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = m.displayName;
    select.append(option);
  }
  select.value = modelByEngine[engine] || "";
}

// The ChatGPT-plan usage card belongs to Codex only; Claude bills against a
// different account. So we cache the last good account payload and let
// renderRuntime decide what (if anything) to show for the active engine.
let lastAccount = null;

async function loadAccount({ retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      lastAccount = await apiFetch("/api/account");
      renderUsage();
      return;
    } catch (error) {
      // /api/account 500s while codex app-server is still warming up; back off.
      if (attempt === retries) {
        logEvent(`account.failed: ${error.message}`);
        renderUsage();
        return;
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

// Render the usage card for the active engine: Codex shows the plan's rate
// limits; Claude shows the last turn's duration/cost (no shared account quota).
function renderUsage() {
  const card = document.querySelector("#usageCard");
  const body = document.querySelector("#usageBody");
  if (activeEngine() === "claude") {
    const thread = currentThread();
    const m = thread?.lastTurn;
    const rateLimit = thread?.rateLimit;
    if (!m && !rateLimit) {
      card.hidden = true;
      return;
    }
    const rows = [`<div class="usage-account">Claude</div>`];
    // Claude headless exposes the 5-hour window's reset + status (no percentage
    // and no weekly window), so show that instead of a Codex-style % bar.
    if (rateLimit) rows.push(claudeRateLimitRow(rateLimit));
    if (m) {
      const bits = [];
      if (m.durationMs) bits.push(`耗时 ${(m.durationMs / 1000).toFixed(1)}s`);
      if (typeof m.costUsd === "number") bits.push(`花费 $${m.costUsd.toFixed(4)}`);
      if (bits.length) rows.push(`<div class="usage-row"><div class="usage-label"><span>本轮</span></div><div class="usage-reset">${escapeHtml(bits.join(" · "))}</div></div>`);
    }
    body.innerHTML = rows.join("");
    card.hidden = false;
    return;
  }
  const data = lastAccount;
  const rl = data?.rateLimits || {};
  if (!data || (!rl.primary && !rl.secondary)) {
    card.hidden = true;
    return;
  }
  const plan = data.account?.planType ? data.account.planType.toUpperCase() : "";
  const rows = [`<div class="usage-account">${escapeHtml(data.account?.email || "")} · ${escapeHtml(plan)}</div>`];
  if (rl.primary) rows.push(usageBar(windowLabel(rl.primary), rl.primary));
  if (rl.secondary) rows.push(usageBar(windowLabel(rl.secondary), rl.secondary));
  body.innerHTML = rows.join("");
  card.hidden = false;
}

// Claude's rate_limit_info → a status line. It carries the window type +
// reset time + allowed/limited status, but no used-percentage, so there's no
// progress bar to draw (unlike Codex).
function claudeRateLimitRow(info) {
  const labels = { five_hour: "5 小时窗口", seven_day: "7 天窗口", weekly: "7 天窗口" };
  const label = labels[info.rateLimitType] || "用量窗口";
  const limited = info.status && info.status !== "allowed";
  const state = limited ? "已受限" : "正常";
  const resets = info.resetsAt
    ? `重置于 ${new Date(info.resetsAt * 1000).toLocaleString("zh-CN", { hour12: false })}`
    : "";
  return `<div class="usage-row">
    <div class="usage-label"><span>${label}</span><span>${state}</span></div>
    ${resets ? `<div class="usage-reset">${escapeHtml(resets)}</div>` : ""}
  </div>`;
}

// Label a rate-limit window from its real duration instead of hardcoding.
function windowLabel(window) {
  const mins = window.windowDurationMins || 0;
  if (mins >= 1440) return `${Math.round(mins / 1440)} 天窗口`;
  if (mins >= 60) return `${Math.round(mins / 60)} 小时窗口`;
  if (mins > 0) return `${mins} 分钟窗口`;
  return "用量";
}

function usageBar(label, window) {
  const pct = Math.max(0, Math.min(100, Math.round(window.usedPercent || 0)));
  const resets = window.resetsAt
    ? new Date(window.resetsAt * 1000).toLocaleString("zh-CN", { hour12: false })
    : "";
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
  return `<div class="usage-row">
    <div class="usage-label"><span>${label}</span><span>${pct}%</span></div>
    <div class="usage-track"><div class="usage-fill ${tone}" style="width:${pct}%"></div></div>
    ${resets ? `<div class="usage-reset">重置于 ${escapeHtml(resets)}</div>` : ""}
  </div>`;
}

async function loadModels() {
  try {
    const { models } = await apiFetch("/api/models");
    codexModels = [{ id: "", displayName: "默认" }, ...models];
    if (activeEngine() === "codex") refreshModelOptions();
  } catch (error) {
    logEvent(`models.failed: ${error.message}`);
  }
}

const sidebarSummary = document.querySelector("#sidebarSummary");
const projectSearch = document.querySelector("#projectSearch");
const threadSearch = document.querySelector("#threadSearch");
const dataSource = document.querySelector("#dataSource");
const currentThreadId = document.querySelector("#currentThreadId");
const threadStatus = document.querySelector("#threadStatus");
const messageCount = document.querySelector("#messageCount");

document.querySelector("#syncBtn").addEventListener("click", syncFromBackend);
document.querySelector("#newThreadBtn").addEventListener("click", addThread);
document.querySelector("#reloadThreadBtn").addEventListener("click", reloadCurrentThread);
document.querySelector("#clearEventsBtn").addEventListener("click", () => {
  state.events = [];
  persist();
  render();
});
document.querySelector("#refreshEventsBtn").addEventListener("click", refreshEvents);
const themeStorageKey = "codex-web-demo-theme";
const themeMeta = document.querySelector('meta[name="theme-color"]');
function applyTheme(theme, { save = true } = {}) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector("#themeBtn").textContent = theme === "dark" ? "☀️" : "🌙";
  // Keep the Android address bar / task switcher in sync with the topbar.
  themeMeta.content = theme === "dark" ? "#161e21" : "#ffffff";
  if (save) localStorage.setItem(themeStorageKey, theme);
}
// Follow the system scheme until the user explicitly picks one.
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
applyTheme(localStorage.getItem(themeStorageKey) || (systemDark.matches ? "dark" : "light"), {
  save: false,
});
systemDark.addEventListener("change", (event) => {
  if (!localStorage.getItem(themeStorageKey)) {
    applyTheme(event.matches ? "dark" : "light", { save: false });
  }
});
document.querySelector("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
});
document.querySelector("#renameThreadBtn").addEventListener("click", renameCurrentThread);
document.querySelector("#archiveThreadBtn").addEventListener("click", archiveCurrentThread);
document.querySelector("#compactThreadBtn").addEventListener("click", compactCurrentThread);

// Mobile drawers: left = project/thread sidebar, right = inspector (运行/事件).
const drawerBackdrop = document.querySelector("#drawerBackdrop");
function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  if (open) document.body.classList.remove("inspector-open");
  syncBackdrop();
}
function setInspector(open) {
  document.body.classList.toggle("inspector-open", open);
  if (open) document.body.classList.remove("drawer-open");
  syncBackdrop();
}
function syncBackdrop() {
  const anyOpen =
    document.body.classList.contains("drawer-open") || document.body.classList.contains("inspector-open");
  drawerBackdrop.hidden = !anyOpen;
}
document.querySelector("#drawerBtn").addEventListener("click", () => setDrawer(true));
document.querySelector("#viewInspectorBtn").addEventListener("click", () => setInspector(true));
drawerBackdrop.addEventListener("click", () => {
  setDrawer(false);
  setInspector(false);
});
// Close the drawer after picking a project or thread on mobile.
document.querySelector("#projectList").addEventListener("click", () => setDrawer(false));
document.querySelector("#threadList").addEventListener("click", () => setDrawer(false));

// Bottom action sheet (long-press menu, confirms and text input — replaces
// window.prompt/confirm, which render as jarring native dialogs in the
// Android PWA and return null in some WebViews).
const sheet = document.querySelector("#sheet");
let sheetDismiss = null;
function showSheet(title, actions, onDismiss = null) {
  document.querySelector("#sheetTitle").textContent = title;
  const wrap = document.querySelector("#sheetActions");
  wrap.innerHTML = "";
  sheetDismiss = onDismiss;
  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `sheet-action${a.danger ? " danger" : ""}`;
    btn.textContent = a.label;
    btn.addEventListener("click", () => {
      sheetDismiss = null;
      sheet.hidden = true;
      a.run();
    });
    wrap.append(btn);
  }
  sheet.hidden = false;
}
function closeSheet() {
  sheet.hidden = true;
  if (sheetDismiss) sheetDismiss();
  sheetDismiss = null;
}
document.querySelector("#sheetCancel").addEventListener("click", closeSheet);
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) closeSheet();
});

// Promise-based confirm: resolves true on the action, false on cancel.
function confirmSheet(title, confirmLabel = "确定", danger = false) {
  return new Promise((resolve) => {
    showSheet(title, [{ label: confirmLabel, danger, run: () => resolve(true) }], () => resolve(false));
  });
}

// Promise-based text input: resolves the string, or null on cancel.
function inputSheet(title, { placeholder = "", value = "", confirmLabel = "确定" } = {}) {
  return new Promise((resolve) => {
    showSheet(title, [], () => resolve(null));
    const wrap = document.querySelector("#sheetActions");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sheet-input";
    input.placeholder = placeholder;
    input.value = value;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "sheet-action confirm";
    ok.textContent = confirmLabel;
    ok.addEventListener("click", () => {
      sheetDismiss = null;
      sheet.hidden = true;
      resolve(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok.click();
    });
    wrap.append(input, ok);
    input.focus();
    input.select();
  });
}

function openThreadActions(thread) {
  state.selectedThreadId = thread.id;
  render();
  showSheet(thread.title || "对话", [
    { label: "重命名", run: renameCurrentThread },
    { label: "压缩上下文", run: compactCurrentThread },
    { label: "归档", danger: true, run: archiveCurrentThread },
  ]);
}

// Edge-swipe from the left to open the sidebar drawer on touch devices.
let edgeStartX = null;
let edgeStartY = null;
document.addEventListener(
  "touchstart",
  (e) => {
    const t = e.touches[0];
    if (!t) return;
    edgeStartX = t.clientX <= 24 ? t.clientX : null;
    edgeStartY = t.clientY;
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  (e) => {
    if (edgeStartX === null) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - edgeStartX;
    const dy = Math.abs(t.clientY - edgeStartY);
    if (dx > 60 && dy < 50 && !document.body.classList.contains("drawer-open")) setDrawer(true);
    edgeStartX = null;
  },
  { passive: true },
);

// Pull-to-refresh on the message list: drag down from the top to reload.
(() => {
  const list = messageList;
  let startY = null;
  let pulling = false;
  list.addEventListener(
    "touchstart",
    (e) => {
      startY = list.scrollTop <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      pulling = false;
    },
    { passive: true },
  );
  list.addEventListener(
    "touchmove",
    (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 12 && list.scrollTop <= 0) {
        pulling = true;
        list.style.transform = `translateY(${Math.min(dy * 0.4, 56)}px)`;
        list.style.transition = "none";
      }
    },
    { passive: true },
  );
  list.addEventListener("touchend", (e) => {
    if (!pulling) {
      startY = null;
      return;
    }
    const dy = e.changedTouches[0].clientY - startY;
    list.style.transition = "transform 0.2s ease";
    list.style.transform = "";
    if (dy > 70 && currentThread()) {
      logEvent("pull.refresh");
      reloadCurrentThread();
    }
    startY = null;
    pulling = false;
  });
})();

// Track the visual viewport so the on-screen keyboard doesn't hide the composer.
if (window.visualViewport) {
  const applyVVH = () => {
    document.documentElement.style.setProperty("--vvh", `${window.visualViewport.height}px`);
  };
  window.visualViewport.addEventListener("resize", applyVVH);
  applyVVH();
}
// Swipe left on the open drawer to close it.
let touchStartX = null;
const sidebarEl = document.querySelector(".sidebar");
sidebarEl.addEventListener("touchstart", (e) => (touchStartX = e.touches[0]?.clientX ?? null), {
  passive: true,
});
sidebarEl.addEventListener(
  "touchend",
  (e) => {
    const x = e.changedTouches[0]?.clientX;
    if (touchStartX !== null && x !== undefined && x - touchStartX < -60) setDrawer(false);
    touchStartX = null;
  },
  { passive: true },
);

// Topbar "more" menu (fork / rollback / review / git diff / skills / mcp).
const moreMenu = document.querySelector("#moreMenu");
document.querySelector("#moreBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (moreMenu.hidden) syncMoreMenu();
  moreMenu.hidden = !moreMenu.hidden;
});

// Tailor the menu to the current conversation's engine: hide Codex-only ops on
// Claude threads (engine switching lives in the composer toggle now).
function syncMoreMenu() {
  const isClaude = (currentThread()?.engine || "codex") === "claude";
  moreMenu.querySelectorAll(".codex-only").forEach((b) => {
    b.style.display = isClaude ? "none" : "";
  });
}
document.addEventListener("click", () => (moreMenu.hidden = true));
moreMenu.addEventListener("click", (e) => e.stopPropagation());
moreMenu.querySelectorAll("button[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    moreMenu.hidden = true;
    runThreadAction(button.dataset.action);
  });
});

const infoModal = document.querySelector("#infoModal");
document.querySelector("#infoClose").addEventListener("click", () => (infoModal.hidden = true));
infoModal.addEventListener("click", (e) => {
  if (e.target === infoModal) infoModal.hidden = true;
});

function showInfo(title, html) {
  document.querySelector("#infoTitle").textContent = title;
  document.querySelector("#infoBody").innerHTML = html;
  infoModal.hidden = false;
  trapFocus(infoModal);
  document.querySelector("#infoClose").focus();
}

// Keep keyboard focus inside an open modal (basic a11y trap).
let releaseTrap = null;
function trapFocus(container) {
  if (releaseTrap) releaseTrap();
  const handler = (event) => {
    if (event.key === "Escape") {
      container.hidden = true;
      if (releaseTrap) releaseTrap();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = container.querySelectorAll(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", handler);
  releaseTrap = () => {
    document.removeEventListener("keydown", handler);
    releaseTrap = null;
  };
}

async function runThreadAction(action) {
  const thread = currentThread();
  const cwd = currentProject()?.path;
  try {
    if (action === "rename") {
      renameCurrentThread();
    } else if (action === "compact") {
      compactCurrentThread();
    } else if (action === "archive") {
      archiveCurrentThread();
    } else if (action === "theme") {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
    } else if (action === "fork") {
      if (!thread) return;
      const { thread: forked } = await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/fork`, {
        method: "POST",
        body: JSON.stringify({ cwd }),
      });
      state.threads.unshift(forked);
      state.selectedThreadId = forked.id;
      logEvent(`thread.forked: ${thread.title}`);
      render();
    } else if (action === "rollback") {
      if (!thread) return;
      if (!(await confirmSheet("回滚最近一轮对话？", "回滚", true))) return;
      await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ numTurns: 1 }),
      });
      logEvent(`thread.rolledback: ${thread.title}`);
      reloadCurrentThread();
    } else if (action === "review") {
      if (!thread) return;
      await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/review`, { method: "POST" });
      logEvent("review.started");
      showInfo("Review", "已发起对未提交改动的 Review，结果会以对话形式返回，可重载对话查看。");
    } else if (action === "summary") {
      if (!thread) return;
      const { summary } = await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/summary`);
      const text = summary?.summary || summary?.text || summary?.preview || "";
      const rows = [];
      if (text) rows.push(`<div class="info-summary">${escapeHtml(text)}</div>`);
      if (summary?.cliVersion) rows.push(`<div class="info-meta">CLI ${escapeHtml(summary.cliVersion)}</div>`);
      if (summary?.gitInfo?.branch) rows.push(`<div class="info-meta">分支 ${escapeHtml(summary.gitInfo.branch)}</div>`);
      if (summary?.updatedAt) rows.push(`<div class="info-meta">更新 ${escapeHtml(String(summary.updatedAt))}</div>`);
      showInfo("会话摘要", rows.join("") || '<div class="info-empty">暂无摘要</div>');
    } else if (action === "gitdiff") {
      const { diff, error } = await apiFetch(`/api/gitdiff?cwd=${encodeURIComponent(cwd || "")}`);
      showInfo(
        "Git Diff",
        diff
          ? `<pre class="info-diff">${highlightDiff(diff)}</pre>`
          : `<div class="info-empty">${escapeHtml(error || "没有可显示的改动")}</div>`,
      );
    } else if (action === "skills") {
      const { skills } = await apiFetch(`/api/skills?cwd=${encodeURIComponent(cwd || "")}`);
      showInfo(
        "可用技能",
        skills.length
          ? skills
              .map(
                (s) =>
                  `<div class="info-item"><strong>${escapeHtml(s.name)}</strong><p>${escapeHtml((s.description || "").slice(0, 160))}</p></div>`,
              )
              .join("")
          : '<div class="info-empty">该项目没有可用技能</div>',
      );
    } else if (action === "plugins") {
      const { plugins } = await apiFetch("/api/plugins");
      showInfo(
        "插件",
        plugins.length
          ? plugins
              .map(
                (p) =>
                  `<div class="info-item"><strong>${escapeHtml(p.id)}</strong><p>${escapeHtml(p.marketplace)}${p.installed ? " · 已安装" : ""}</p></div>`,
              )
              .join("")
          : '<div class="info-empty">没有可用插件</div>',
      );
    } else if (action === "mcp") {
      const { servers } = await apiFetch("/api/mcp");
      showInfo(
        "MCP 服务器",
        servers.length
          ? servers
              .map(
                (s) =>
                  `<div class="info-item"><strong>${escapeHtml(s.name)}</strong><p>${s.tools.length} 个工具：${escapeHtml(s.tools.slice(0, 12).join(", "))}</p></div>`,
              )
              .join("")
          : '<div class="info-empty">没有已连接的 MCP 服务器</div>',
      );
    }
  } catch (error) {
    showInfo("出错了", `<div class="info-empty">${escapeHtml(error.message)}</div>`);
  }
}
document.querySelector("#connectBtn").addEventListener("click", testConnection);
projectSearch.addEventListener("input", () => {
  ui.projectSearch = projectSearch.value.trim().toLowerCase();
  renderProjects();
});
let searchTimer = null;
threadSearch.addEventListener("input", () => {
  ui.threadSearch = threadSearch.value.trim().toLowerCase();
  const term = threadSearch.value.trim();
  clearTimeout(searchTimer);
  if (term.length >= 2) {
    searchTimer = setTimeout(() => crossThreadSearch(term), 280);
  } else {
    ui.searchResults = null;
    renderThreads();
  }
});

// Cross-thread search across all projects via the app-server.
async function crossThreadSearch(term) {
  // Local Claude conversations aren't in Codex's thread/search index, so match
  // them client-side and merge so they don't vanish from the list when searching.
  const lower = term.toLowerCase();
  const claudeHits = state.threads.filter(
    (t) => t.engine === "claude" && (t.title || "").toLowerCase().includes(lower),
  );
  try {
    const { threads } = await apiFetch(`/api/search?q=${encodeURIComponent(term)}`);
    ui.searchResults = [...claudeHits, ...threads];
  } catch (error) {
    ui.searchResults = claudeHits;
    logEvent(`search.failed: ${error.message}`);
  }
  renderThreads();
}
// Touch devices: the soft keyboard's Enter key sends (enterkeyhint="send"),
// and the placeholder shouldn't mention desktop shortcuts.
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
if (coarsePointer) promptInput.placeholder = "给 Codex 一个任务…";
promptInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    composer.requestSubmit();
  } else if (coarsePointer && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
// Auto-grow the textarea with its content (the drag-resize handle is useless
// on touch screens); cap at the CSS max-height.
promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 150)}px`;
});
document.querySelectorAll(".prompt-chip[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    promptInput.value = button.dataset.prompt;
    promptInput.focus();
  });
});

// @ file mentions: type "@query" to fuzzy-search the project's files.
const mentionPopup = document.querySelector("#mentionPopup");
let mentionState = null;
promptInput.addEventListener("input", onMentionInput);
promptInput.addEventListener("blur", () => setTimeout(hideMention, 150));

function onMentionInput() {
  const value = promptInput.value;
  const caret = promptInput.selectionStart;
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return hideMention();
  const query = match[1];
  mentionState = { start: caret - query.length, end: caret };
  if (query.length < 1) return hideMention();
  fetchMentions(query);
}

async function fetchMentions(query) {
  try {
    const root = currentProject()?.path || "";
    const { files } = await apiFetch(
      `/api/files?q=${encodeURIComponent(query)}&root=${encodeURIComponent(root)}`,
    );
    if (!files.length) return hideMention();
    mentionPopup.innerHTML = "";
    files.forEach((file) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "mention-item";
      item.textContent = file.path;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insertMention(file.path);
      });
      mentionPopup.append(item);
    });
    mentionPopup.hidden = false;
  } catch {
    hideMention();
  }
}

function insertMention(path) {
  if (!mentionState) return;
  const value = promptInput.value;
  const next = `${value.slice(0, mentionState.start)}${path} ${value.slice(mentionState.end)}`;
  promptInput.value = next;
  promptInput.focus();
  hideMention();
}

function hideMention() {
  mentionPopup.hidden = true;
  mentionState = null;
}

// Voice mode: Web Speech API for input, SpeechSynthesis for reading replies.
const micBtn = document.querySelector("#micBtn");
const ttsBtn = document.querySelector("#ttsBtn");
let ttsEnabled = false;
let recognition = null;

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRec) {
  micBtn.disabled = true;
  micBtn.title = "此浏览器不支持语音输入";
}

micBtn.addEventListener("click", () => {
  if (!SpeechRec) return;
  if (recognition) {
    recognition.stop();
    return;
  }
  recognition = new SpeechRec();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = false;
  micBtn.classList.add("recording");
  micBtn.textContent = "🎙️ 听写中";
  let finalText = "";
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += t;
      else interim += t;
    }
    promptInput.value = (finalText + interim).trim();
  };
  recognition.onerror = () => logEvent("voice.error");
  recognition.onend = () => {
    micBtn.classList.remove("recording");
    micBtn.textContent = "🎤 语音";
    recognition = null;
    promptInput.focus();
  };
  recognition.start();
});

ttsBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  ttsBtn.classList.toggle("active", ttsEnabled);
  ttsBtn.setAttribute("aria-pressed", String(ttsEnabled));
  if (!ttsEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
});

function speakReply(text) {
  if (!ttsEnabled || !window.speechSynthesis || !text) return;
  const utter = new SpeechSynthesisUtterance(text.slice(0, 600));
  utter.lang = "zh-CN";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// Image attachments (paste or pick) sent with the next turn.
let pendingImages = [];
const attachInput = document.querySelector("#attachInput");
const attachPreview = document.querySelector("#attachPreview");
document.querySelector("#attachBtn").addEventListener("click", () => attachInput.click());
attachInput.addEventListener("change", () => {
  addImageFiles([...attachInput.files]);
  attachInput.value = "";
});
promptInput.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items || [])]
    .filter((i) => i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (files.length) {
    event.preventDefault();
    addImageFiles(files);
  }
});

function addImageFiles(files) {
  for (const file of files.slice(0, 6)) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      if (pendingImages.length >= 6) return;
      pendingImages.push(reader.result);
      renderAttachPreview();
    };
    reader.readAsDataURL(file);
  }
}

function renderAttachPreview() {
  attachPreview.innerHTML = "";
  pendingImages.forEach((src, index) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    const img = document.createElement("img");
    img.src = src;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingImages.splice(index, 1);
      renderAttachPreview();
    });
    chip.append(img, remove);
    attachPreview.append(chip);
  });
}
composer.addEventListener("submit", sendPrompt);

render();
syncFromBackend();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return saved?.projects?.length ? saved : structuredClone(seedState);
  } catch {
    return structuredClone(seedState);
  }
}

function persist() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function currentProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId);
}

function currentThread() {
  return state.threads.find((thread) => thread.id === state.selectedThreadId);
}

function projectThreads(projectId) {
  return state.threads.filter((thread) => thread.projectId === projectId);
}

function render() {
  renderProjects();
  renderThreads();
  renderMessages();
  renderEvents();
  renderRuntime();
  renderEngineSwitch();
  persist();
}

function renderProjects() {
  projectList.innerHTML = "";
  const projects = state.projects.filter((project) => {
    const haystack = `${project.name} ${project.path}`.toLowerCase();
    return haystack.includes(ui.projectSearch);
  });

  if (!projects.length) {
    projectList.innerHTML = '<div class="empty slim">没有匹配项目</div>';
    return;
  }

  projects.forEach((project) => {
    const count = projectThreads(project.id).length;
    const button = document.createElement("button");
    button.className = `project-card ${project.id === state.selectedProjectId ? "active" : ""}`;
    button.innerHTML = `
      <span class="card-row">
        <span class="card-title">${escapeHtml(project.name)}</span>
        <span class="count-badge">${count}</span>
      </span>
      <span class="card-subtitle">${escapeHtml(shortPath(project.path))}</span>
    `;
    button.addEventListener("click", () => {
      state.selectedProjectId = project.id;
      state.selectedThreadId = projectThreads(project.id)[0]?.id ?? null;
      logEvent(`project.selected: ${project.name}`);
      render();
    });
    projectList.append(button);
  });
}

function renderThreads() {
  threadList.innerHTML = "";
  const searching = Array.isArray(ui.searchResults);
  const threads = searching
    ? ui.searchResults
    : projectThreads(state.selectedProjectId).filter((thread) => {
        const haystack = `${thread.title} ${thread.updatedAt}`.toLowerCase();
        return haystack.includes(ui.threadSearch);
      });
  if (!threads.length) {
    threadList.innerHTML = `<div class="empty slim">${searching ? "没有搜到对话" : "这个项目没有匹配对话"}</div>`;
    return;
  }

  threads.forEach((thread) => {
    const button = document.createElement("button");
    button.className = `thread-card ${thread.id === state.selectedThreadId ? "active" : ""}`;
    const sub = searching
      ? shortPath(thread.path || "")
      : `${thread.updatedAt || "未更新"}${thread.messages.length ? ` · ${thread.messages.length} 条消息` : ""}`;
    const engine = thread.engine === "claude" ? "claude" : "codex";
    const badge = `<span class="engine-badge ${engine}" title="${engine === "claude" ? "Claude Code" : "Codex"}">${engine === "claude" ? "✶" : "C"}</span>`;
    button.innerHTML = `
      <span class="card-row">${badge}<span class="card-title">${escapeHtml(thread.title)}</span></span>
      <span class="card-subtitle">${escapeHtml(sub)}</span>
    `;
    // Long-press opens a quick action sheet (rename / compact / archive).
    // Android fires both the 500ms timer and contextmenu on a long press, so
    // both paths funnel through openOnce to avoid double-opening the sheet.
    let pressTimer = null;
    const openOnce = () => {
      if (sheet.hidden) openThreadActions(thread);
    };
    const startPress = () => {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        openOnce();
      }, 500);
    };
    const cancelPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };
    button.addEventListener("touchstart", startPress, { passive: true });
    button.addEventListener("touchend", cancelPress);
    button.addEventListener("touchmove", cancelPress, { passive: true });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cancelPress();
      openOnce();
    });
    button.addEventListener("click", () => {
      if (pressTimer === null && sheet && !sheet.hidden) return; // long-press already handled
      if (searching && thread.projectId) {
        if (!state.projects.some((p) => p.id === thread.projectId)) {
          state.projects.push({ id: thread.projectId, name: thread.path?.split("/").pop() || thread.projectId, path: thread.path });
        }
        state.selectedProjectId = thread.projectId;
        if (!state.threads.some((t) => t.id === thread.id)) state.threads.push(thread);
      }
      state.selectedThreadId = thread.id;
      logEvent(`thread.resumed: ${thread.title}`);
      render();
      loadThread(thread.id)
        .then(render)
        .catch((error) => {
          logEvent(`thread.read.failed: ${error.message}`);
          render();
        });
    });
    threadList.append(button);
  });
}

function renderMessages() {
  const project = currentProject();
  const thread = currentThread();
  const threadChanged = thread?.id !== ui.lastThreadId;
  if (threadChanged) {
    ui.messageLimit = 60;
    ui.lastThreadId = thread?.id;
  }
  // Follow streamed output only while the user is already at the bottom —
  // otherwise every delta re-render would yank them back down mid-read.
  const nearBottom =
    messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  currentProjectPath.textContent = project?.path ?? "";
  threadTitle.textContent = thread?.title ?? "选择一个对话";
  threadMeta.textContent = thread
    ? `${thread.engine === "claude" ? "Claude" : "Codex"} · ${thread.messages.length || 0} 条消息 · ${thread.updatedAt || "未更新"}`
    : "从左侧选择一个线程开始";
  messageList.innerHTML = "";

  if (!thread) {
    messageList.innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">💬</div>
        <p>选择一个对话，或开始新的任务</p>
        <div class="empty-actions">
          <button type="button" id="emptyNewBtn" class="empty-cta">＋ 新对话</button>
          <button type="button" id="emptyOpenBtn" class="empty-cta ghost">打开项目/对话</button>
        </div>
      </div>`;
    messageList.querySelector("#emptyNewBtn")?.addEventListener("click", addThread);
    messageList.querySelector("#emptyOpenBtn")?.addEventListener("click", () => setDrawer(true));
    return;
  }

  if (ui.loadingThread === thread.id && !thread.messages.length) {
    messageList.innerHTML = `
      <div class="skeleton-msg"></div>
      <div class="skeleton-msg short"></div>
      <div class="skeleton-msg"></div>`;
    return;
  }

  if (!thread.messages.length) {
    messageList.innerHTML =
      '<div class="empty-state"><div class="empty-emoji">✦</div><p>给 Codex 一个任务，回复会显示在这里</p></div>';
    return;
  }

  // Window large transcripts: render only the most recent N, with a button to
  // reveal earlier messages (keeps the DOM light on long threads).
  const limit = ui.messageLimit || 60;
  const all = thread.messages;
  const visible = all.length > limit ? all.slice(-limit) : all;
  if (visible.length < all.length) {
    const more = document.createElement("button");
    more.className = "load-earlier";
    more.textContent = `显示更早的 ${all.length - visible.length} 条`;
    more.addEventListener("click", () => {
      ui.messageLimit = (ui.messageLimit || 60) + 100;
      renderMessages();
    });
    messageList.append(more);
  }

  for (const group of groupMessages(visible)) {
    if (group.role === "user") {
      group.messages.forEach((message) => {
        const row = document.createElement("div");
        row.className = "msg-row user";
        row.append(buildBubble(message));
        messageList.append(row);
      });
    } else if (group.role === "event") {
      group.messages.forEach((message) => messageList.append(buildEvent(message)));
    } else {
      const block = document.createElement("article");
      block.className = "agent-turn";
      const head = document.createElement("div");
      head.className = "agent-head";
      const meta = group.messages.find((m) => m.durationMs || m.turnStatus);
      const bits = [thread.engine === "claude" ? "Claude" : "Codex"];
      if (meta?.durationMs) bits.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
      if (meta?.turnStatus && meta.turnStatus !== "completed") bits.push(meta.turnStatus);
      head.textContent = bits.join(" · ");
      block.append(head);
      group.messages.forEach((message) => {
        const body = document.createElement("div");
        body.className = "agent-body";
        renderContent(body, message, true);
        block.append(body);
      });
      messageList.append(block);
    }
  }
  if (threadChanged || nearBottom) messageList.scrollTop = messageList.scrollHeight;
}

// Render a non-message transcript item (tool call, web search, file change…).
function buildEvent(message) {
  const el = document.createElement("div");
  el.className = `transcript-event kind-${message.kind}`;
  if (message.kind === "fileChange") {
    const files = (message.files || [])
      .map((f) => {
        const label = { add: "新增", update: "修改", delete: "删除" }[f.change] || f.change;
        return `<div class="evt-file">
          <span class="evt-tag ${f.change}">${label}</span>
          <span class="evt-path">${escapeHtml(shortPath(f.path || ""))}</span>
          <span class="evt-diffstat">+${f.additions} −${f.deletions}</span>
        </div>`;
      })
      .join("");
    const diffs = (message.files || [])
      .filter((f) => f.diff)
      .map((f) => `<pre class="evt-diff">${highlightDiff(f.diff)}</pre>`)
      .join("");
    el.innerHTML = `<div class="evt-head">📝 文件改动</div>${files}
      ${diffs ? `<details><summary>查看 diff</summary>${diffs}</details>` : ""}`;
  } else if (message.kind === "webSearch") {
    const qs = (message.queries || []).map((q) => `<li>${escapeHtml(q)}</li>`).join("");
    el.innerHTML = `<div class="evt-head">🔍 联网搜索</div><ul class="evt-queries">${qs}</ul>`;
  } else if (message.kind === "tool") {
    const dur = message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : "";
    el.innerHTML = `<div class="evt-head">🔧 工具调用</div>
      <div class="evt-meta">${escapeHtml(message.server || "")} / ${escapeHtml(message.tool || "")}
      · ${escapeHtml(message.status || "")}${dur}</div>
      ${message.title ? `<div class="evt-title">${escapeHtml(message.title)}</div>` : ""}`;
  } else if (message.kind === "image") {
    el.innerHTML = `<div class="evt-head">🖼️ 生成图片</div>`;
    if (message.images?.length) {
      const grid = document.createElement("div");
      grid.className = "msg-images";
      message.images.forEach((src) => {
        const url = imageUrl(src);
        const img = document.createElement("img");
        img.src = url;
        img.addEventListener("click", () => openImageViewer(url));
        grid.append(img);
      });
      el.append(grid);
    }
  } else if (message.kind === "command") {
    const code = message.exitCode;
    const tag = code === 0 ? "ok" : code == null ? "" : "fail";
    const dur = message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : "";
    el.innerHTML = `<div class="evt-head">🔧 命令执行 ${
      code != null ? `<span class="evt-exit ${tag}">exit ${code}</span>` : ""
    }${dur}</div>
      <pre class="evt-cmd">${escapeHtml(message.command || "")}</pre>
      ${message.output ? `<details><summary>输出</summary><pre class="evt-output">${escapeHtml(message.output.slice(0, 4000))}</pre></details>` : ""}`;
  } else if (message.kind === "reasoning") {
    el.innerHTML = `<details class="evt-reasoning"><summary>💭 推理过程</summary><div class="evt-reasoning-body">${
      window.CodexMarkdown ? window.CodexMarkdown.renderMarkdown(message.text || "") : escapeHtml(message.text || "")
    }</div></details>`;
  } else if (message.kind === "compaction") {
    el.innerHTML = `<div class="evt-head">⋯ 上下文已压缩</div>`;
  } else {
    el.textContent = message.kind || "事件";
  }
  return el;
}

function highlightDiff(diff) {
  return diff
    .split("\n")
    .map((line) => {
      const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
}

// Merge consecutive same-role messages into one group so a run of Codex
// turns shows a single "Codex" header instead of one per message.
function groupMessages(messages) {
  const groups = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (last && last.role === message.role) last.messages.push(message);
    else groups.push({ role: message.role, messages: [message] });
  }
  return groups;
}

function buildBubble(message) {
  const bubble = document.createElement("div");
  bubble.className = "bubble user";
  renderContent(bubble, message);
  return bubble;
}

function renderContent(container, message, markdown = false) {
  if (message.text) {
    const text = document.createElement("div");
    text.className = "msg-text";
    if (markdown && window.CodexMarkdown) {
      text.classList.add("markdown");
      text.innerHTML = window.CodexMarkdown.renderMarkdown(message.text);
      enhanceCodeBlocks(text);
    } else {
      text.textContent = message.text;
    }
    container.append(text);
  }
  if (message.images?.length) {
    const grid = document.createElement("div");
    grid.className = "msg-images";
    message.images.forEach((src) => {
      const url = imageUrl(src);
      const img = document.createElement("img");
      img.src = url;
      img.loading = "lazy";
      img.alt = "图片";
      img.addEventListener("click", () => openImageViewer(url));
      grid.append(img);
    });
    container.append(grid);
  }
}

// Resolve a server-cached /img/<id> URL against the backend base; data URLs pass through.
function imageUrl(src) {
  return src && src.startsWith("/img/") ? `${apiBase()}${src}` : src;
}

function renderEvents() {
  eventList.innerHTML = "";
  const events = state.events.slice(-40);
  if (!events.length) {
    eventList.innerHTML = '<div class="empty slim">暂无事件</div>';
    return;
  }
  events.forEach((event) => {
    const summary = summarizeEvent(event);
    const item = document.createElement("div");
    item.className = `event ${summary.tone === "warn" ? "warn" : ""}`;
    item.title = event;
    item.innerHTML = `
      <span class="event-time">${escapeHtml(summary.time)}</span>
      <span class="event-label">${escapeHtml(summary.label)}</span>
    `;
    eventList.append(item);
  });
}

function summarizeEvent(event) {
  const timeMatch = event.match(/^(\d{1,2}:\d{2}(?::\d{2})?)/);
  const time = timeMatch?.[1] ?? "local";
  const body = timeMatch ? event.slice(timeMatch[1].length).trim() : event;
  const lower = body.toLowerCase();
  const tone = lower.includes("failed") || lower.includes("error") || lower.includes('"level":"warn"')
    ? "warn"
    : "normal";

  if (body.includes("codex.stderr")) {
    const pluginMatch = body.match(/"plugin":"([^"]+)"/);
    if (pluginMatch) return { time, tone: "warn", label: `插件警告 · ${pluginMatch[1]}` };
    if (body.includes("failed to refresh available models")) {
      return { time, tone: "warn", label: "模型列表刷新失败" };
    }
    return { time, tone, label: "Codex 后台日志" };
  }
  if (body.includes("sync.loaded")) return { time, tone, label: body.replace("sync.loaded:", "同步完成 ·") };
  if (body.includes("thread.resumed")) return { time, tone, label: body.replace("thread.resumed:", "打开对话 ·") };
  if (body.includes("thread.read.failed")) return { time, tone: "warn", label: "读取对话失败" };
  if (body.includes("turn.reply.partial")) return { time, tone, label: "已收到回复，后台仍可能收尾" };
  if (body.includes("turn.completed")) return { time, tone, label: "发送完成" };
  if (body.includes("turn.failed")) return { time, tone: "warn", label: "发送失败" };
  if (body.includes("Reconnecting")) return { time, tone: "warn", label: body.replace("error:", "Codex 流重连中 ·") };
  if (body.includes("backend.ready")) return { time, tone, label: "后端在线" };
  if (body.includes("backend.failed")) return { time, tone: "warn", label: "后端连接失败" };
  if (body.includes("demo.ready")) return { time, tone, label: "Demo 数据已加载" };
  if (body.includes("sync.pending")) return { time, tone, label: "等待后端同步" };
  return { time, tone, label: body.length > 96 ? `${body.slice(0, 96)}…` : body };
}

function renderRuntime() {
  const project = currentProject();
  const thread = currentThread();
  const engine = activeEngine();
  sidebarSummary.textContent = `${state.projects.length} 个项目 · ${state.threads.length} 个线程`;
  // "连接" is plain connection state; the engine gets its own cell instead of a
  // raw thread UUID nobody reads (the full id stays available on hover).
  dataSource.textContent = ui.dataSource === "Mock" ? "Mock" : "已连接";
  currentThreadId.textContent = thread ? (engine === "claude" ? "Claude" : "Codex") : "未选择";
  currentThreadId.title = thread ? thread.id : "";
  threadStatus.textContent = statusText(thread?.status);
  messageCount.textContent = String(thread?.messages.length || 0);
  currentProjectPath.title = project?.path || "";
  // Run settings other than the model are Codex-only; disable them on Claude.
  const codexOnlySettings = engine !== "claude";
  for (const key of ["effort", "approvalPolicy", "sandbox"]) {
    settingsControls[key].disabled = !codexOnlySettings;
  }
  // Claude headless turns don't accept inline images yet — hide the attach chip.
  const attachBtn = document.querySelector("#attachBtn");
  if (attachBtn) attachBtn.style.display = engine === "claude" ? "none" : "";
  // Swap the model dropdown + usage panel when the active engine changes.
  if (ui.lastEngine !== engine) {
    ui.lastEngine = engine;
    refreshModelOptions();
  }
  renderUsage();
}

async function addThread() {
  const project = currentProject();
  if (!project) return;
  const engine = await chooseEngine();
  if (!engine) return;
  createBackendThread(project, engine);
}

// Engine segmented toggle above the composer. Delegate clicks so wiring works
// regardless of where this runs relative to the initial render().
document.querySelector(".engine-switch")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".engine-opt");
  if (btn) switchEngineTo(btn.dataset.engine);
});

function renderEngineSwitch() {
  const el = document.querySelector(".engine-switch");
  if (!el) return;
  const engine = currentThread()?.engine || "codex";
  el.querySelectorAll(".engine-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.engine === engine);
  });
}

// Switch the working engine. With an in-progress conversation this forks to a
// new conversation on the target engine, seeding the recent transcript; with no
// (or an empty) conversation it just starts a fresh one on that engine.
async function switchEngineTo(to) {
  const thread = currentThread();
  const project = currentProject();
  if (thread && thread.engine === to) return; // already on it
  if (!thread || !thread.messages.length) {
    if (project) createBackendThread(project, to);
    return;
  }
  try {
    const { thread: newThread, seedPrompt } = await apiFetch(
      `/api/threads/${encodeURIComponent(thread.id)}/switch-engine`,
      { method: "POST", body: JSON.stringify({ to, cwd: project?.path, settings: currentSettings() }) },
    );
    state.threads.unshift(newThread);
    state.selectedThreadId = newThread.id;
    logEvent(`engine.switched: → ${to}`);
    render();
    // Seed the composer with the prior context so the first turn carries it.
    if (seedPrompt) {
      promptInput.value = seedPrompt;
      promptInput.dispatchEvent(new Event("input"));
    }
    showInfo(
      "已切换引擎",
      `<div class="info-item"><strong>已新建 ${to === "claude" ? "Claude" : "Codex"} 对话</strong><p>此前对话记录已填入输入框作为上下文，按需编辑后发送即可继续。</p></div>`,
    );
  } catch (error) {
    showInfo("切换失败", `<div class="info-empty">${escapeHtml(error.message)}</div>`);
  }
}

// Bottom-sheet engine picker for a new conversation.
function chooseEngine() {
  return new Promise((resolve) => {
    showSheet(
      "选择引擎",
      [
        { label: "Codex", run: () => resolve("codex") },
        { label: "Claude Code", run: () => resolve("claude") },
      ],
      () => resolve(null),
    );
  });
}

async function sendPrompt(event) {
  event.preventDefault();
  const thread = currentThread();
  const text = promptInput.value.trim();
  // Claude headless turns don't accept inline images; drop them so we never
  // send an empty prompt or silently lose them.
  const images = thread?.engine === "claude" ? [] : pendingImages.slice();
  if (!thread || (!text && !images.length)) return;

  thread.messages.push({ role: "user", text, images });
  const engineName = thread.engine === "claude" ? "Claude" : "Codex";
  const pendingMessage = { role: "agent", text: `${engineName} 正在处理...` };
  thread.messages.push(pendingMessage);
  // Auto-title a still-unnamed conversation from its first prompt. Codex hands
  // back "未命名对话" and Claude "新对话", so treat both placeholders as unnamed.
  if (text && (!thread.title || ["新对话", "未命名对话"].includes(thread.title))) {
    thread.title = text.slice(0, 24);
  }
  thread.updatedAt = "刚刚";
  promptInput.value = "";
  promptInput.style.height = "";
  pendingImages = [];
  renderAttachPreview();
  activeTurnThreadId = thread.id;
  setSending(true);
  render();
  // Always reveal the just-sent message, even if the user had scrolled up.
  messageList.scrollTop = messageList.scrollHeight;

  const stopPolling = pollEvents();
  let streamed = "";
  const stopStream = streamTurn(
    thread.id,
    (delta) => {
      streamed += delta;
      pendingMessage.text = streamed;
      renderMessages();
    },
    () => {},
    (label) => {
      if (!streamed && label) {
        pendingMessage.text = label;
        renderMessages();
      }
    },
    (item) => {
      // Insert live tool/command/reasoning blocks just before the pending reply.
      const idx = thread.messages.indexOf(pendingMessage);
      if (idx >= 0) thread.messages.splice(idx, 0, item);
      else thread.messages.push(item);
      renderMessages();
    },
  );
  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/turns`, {
      method: "POST",
      body: JSON.stringify({ text, cwd: currentProject()?.path, settings: currentSettings(), images }),
    });
    mergeEvents(response.events);
    const nextThread = ensureTurnReply(response.thread, response.reply);
    replaceThread(nextThread);
    state.selectedThreadId = nextThread.id;
    logEvent(response.partial ? `turn.reply.partial: ${thread.id}` : `turn.completed: ${thread.id}`);
    speakReply(streamed || response.reply);
    if (response.partial) scheduleThreadRefresh(nextThread.id);
    // Refresh the Codex rate-limit usage after a turn (the % moves).
    if (nextThread.engine !== "claude") loadAccount({ retries: 0 });
  } catch (error) {
    pendingMessage.text = formatSendError(error.message);
    logEvent(`turn.failed: ${error.message}`);
  } finally {
    stopStream();
    stopPolling();
    activeTurnThreadId = null;
    setSending(false);
  }
  render();
}

function ensureTurnReply(thread, reply) {
  if (!reply?.trim()) return thread;
  const normalized = reply.trim();
  const hasReply = thread.messages.some((message) => {
    return message.role === "agent" && message.text?.trim() === normalized;
  });
  if (!hasReply) thread.messages.push({ role: "agent", text: normalized });
  return thread;
}

function scheduleThreadRefresh(threadId) {
  setTimeout(() => {
    if (state.selectedThreadId !== threadId) return;
    loadThread(threadId)
      .then(render)
      .catch((error) => {
        logEvent(`thread.refresh.failed: ${error.message}`);
        renderEvents();
      });
  }, 2500);
}

async function testConnection() {
  setConnStatus("连接中");
  logEvent(`backend.check: ${apiBase()}`);

  try {
    await apiFetch("/health", { signal: AbortSignal.timeout(1500) });
    setConnStatus("后端在线");
    ui.dataSource = "Health OK";
    logEvent("backend.ready");
    await syncFromBackend();
  } catch (error) {
    setConnStatus("Mock 模式");
    logEvent(`backend.failed: ${error.message}`);
  }

  render();
}

async function syncFromBackend() {
  try {
    setConnStatus("同步中");
    const payload = await apiFetch("/api/sync");
    state.projects = payload.projects;
    state.threads = payload.threads;
    ui.dataSource = payload.source || "Codex";
    mergeEvents(payload.events);
    state.selectedProjectId = keepSelected(
      state.selectedProjectId,
      state.projects.map((project) => project.id),
      state.projects[0]?.id,
    );
    state.selectedThreadId = keepSelected(
      state.selectedThreadId,
      projectThreads(state.selectedProjectId).map((thread) => thread.id),
      projectThreads(state.selectedProjectId)[0]?.id,
    );
    setConnStatus("真实数据");
    logEvent(`sync.loaded: ${state.threads.length} threads`);
    loadModels();
    loadAccount();
  } catch (error) {
    setConnStatus("Mock 模式");
    ui.dataSource = "Mock";
    logEvent(`sync.failed: ${error.message}`);
  }
  render();
}

async function loadThread(threadId) {
  setConnStatus("读取线程");
  ui.loadingThread = threadId;
  renderMessages();
  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`);
    mergeEvents(response.events);
    replaceThread(response.thread);
    setConnStatus("真实数据");
  } finally {
    ui.loadingThread = null;
  }
}

async function renameCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  const name = await inputSheet("重命名对话", { value: thread.title || "", confirmLabel: "重命名" });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === thread.title) return;
  try {
    await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name: trimmed }),
    });
    thread.title = trimmed;
    logEvent(`thread.renamed: ${trimmed}`);
  } catch (error) {
    logEvent(`thread.rename.failed: ${error.message}`);
  }
  render();
}

async function archiveCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  if (!(await confirmSheet(`归档对话「${thread.title}」？归档后将从列表移除。`, "归档", true))) return;
  try {
    await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/archive`, { method: "POST" });
    state.threads = state.threads.filter((t) => t.id !== thread.id);
    state.selectedThreadId = projectThreads(state.selectedProjectId)[0]?.id ?? null;
    logEvent(`thread.archived: ${thread.title}`);
  } catch (error) {
    logEvent(`thread.archive.failed: ${error.message}`);
  }
  render();
}

async function compactCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  try {
    await apiFetch(`/api/threads/${encodeURIComponent(thread.id)}/compact`, { method: "POST" });
    logEvent(`thread.compact.started: ${thread.title}`);
  } catch (error) {
    logEvent(`thread.compact.failed: ${error.message}`);
  }
  render();
}

function reloadCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  loadThread(thread.id)
    .then(render)
    .catch((error) => {
      logEvent(`thread.reload.failed: ${error.message}`);
      render();
    });
}

function eventsPath() {
  const id = currentThread()?.id;
  return id ? `/api/events?threadId=${encodeURIComponent(id)}` : "/api/events";
}

async function refreshEvents() {
  try {
    const response = await apiFetch(eventsPath());
    mergeEvents(response.events);
  } catch (error) {
    logEvent(`events.failed: ${error.message}`);
  }
  render();
}

async function createBackendThread(project, engine = "codex") {
  try {
    const response = await apiFetch("/api/threads", {
      method: "POST",
      body: JSON.stringify({ cwd: project.path, settings: currentSettings(), engine }),
    });
    mergeEvents(response.events);
    state.threads.unshift(response.thread);
    state.selectedThreadId = response.thread.id;
    logEvent(`thread.started: ${project.name}`);
  } catch (error) {
    const id = `t${Date.now()}`;
    state.threads.unshift({
      id,
      projectId: project.id,
      title: "新对话",
      updatedAt: "刚刚",
      messages: [{ role: "agent", text: `新建失败：${error.message}` }],
    });
    state.selectedThreadId = id;
    logEvent(`thread.failed: ${error.message}`);
  }
  render();
}

function replaceThread(nextThread) {
  const index = state.threads.findIndex((thread) => thread.id === nextThread.id);
  if (index >= 0) state.threads.splice(index, 1, nextThread);
  else state.threads.unshift(nextThread);
}

function keepSelected(current, ids, fallback) {
  return ids.includes(current) ? current : fallback ?? null;
}

function apiBase() {
  return backendUrl.value.replace(/\/$/, "") || window.location.origin;
}

async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const response = await fetch(`${apiBase()}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function mergeEvents(events = []) {
  for (const event of events) {
    if (!state.events.includes(event)) state.events.push(event);
  }
  state.events = state.events.slice(-100);
}

// Live-stream a turn's agent deltas via SSE. Returns a function to stop streaming.
const PROGRESS_LABELS = {
  reasoning: "💭 推理中…",
  commandExecution: "🔧 执行命令中…",
  fileChange: "📝 修改文件中…",
  webSearch: "🔍 联网搜索中…",
  mcpToolCall: "🧩 调用工具中…",
  imageGeneration: "🖼️ 生成图片中…",
};

function streamTurn(threadId, onDelta, onDone, onStatus, onItem) {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${apiBase()}/api/stream?threadId=${encodeURIComponent(threadId)}`, {
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const part of parts) {
          const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(5).trim());
            if (event.type === "delta") onDelta(event.delta || "");
            else if (event.type === "turnCompleted") onDone();
            else if (event.type === "item" && onItem) onItem(event.item);
            else if (event.type === "progress" && onStatus) {
              onStatus(PROGRESS_LABELS[event.itemType] || null);
            }
          } catch {
            // ignore malformed chunk
          }
        }
      }
    } catch {
      // aborted or stream unsupported — POST result is the fallback.
    }
  })();
  return () => controller.abort();
}

function pollEvents() {
  const timer = setInterval(async () => {
    try {
      const response = await apiFetch(eventsPath());
      mergeEvents(response.events);
      renderEvents();
      renderApprovals(response.approvals);
    } catch {
      // The send request owns the visible error path.
    }
  }, 2000);
  return () => clearInterval(timer);
}

const approvalLayer = document.querySelector("#approvalLayer");

// Codex may pause a turn to ask permission for a command or file change.
// Render those requests as a blocking dialog so the turn never hangs.
function renderApprovals(approvals = []) {
  if (!approvals.length) {
    approvalLayer.hidden = true;
    approvalLayer.innerHTML = "";
    return;
  }
  const approval = approvals[0];
  const s = approval.summary || {};
  const isCommand = s.kind === "command";
  const title = isCommand ? "Codex 请求执行命令" : "Codex 请求修改文件";
  const detail = isCommand
    ? `<pre class="approval-cmd">${escapeHtml(s.command || "(命令未提供)")}</pre>
       ${s.cwd ? `<div class="approval-meta">目录：${escapeHtml(s.cwd)}</div>` : ""}`
    : `<div class="approval-meta">${escapeHtml(s.grantRoot ? `授予路径：${s.grantRoot}` : "Codex 想写入沙箱外文件")}</div>`;
  const reason = s.reason ? `<div class="approval-reason">${escapeHtml(s.reason)}</div>` : "";

  approvalLayer.innerHTML = `
    <div class="approval-card" role="alertdialog" aria-label="${title}">
      <h3>${title}</h3>
      ${detail}
      ${reason}
      <div class="approval-actions">
        <button data-decision="accept" class="approve">允许</button>
        <button data-decision="acceptForSession" class="approve-soft">本会话允许</button>
        <button data-decision="decline" class="deny">拒绝</button>
        <button data-decision="cancel" class="deny-soft">拒绝并中断</button>
      </div>
      ${approvals.length > 1 ? `<div class="approval-meta">还有 ${approvals.length - 1} 个待处理</div>` : ""}
    </div>
  `;
  approvalLayer.querySelectorAll("button[data-decision]").forEach((button) => {
    button.addEventListener("click", () => decideApproval(approval.id, button.dataset.decision));
  });
  approvalLayer.hidden = false;
}

async function decideApproval(id, decision) {
  approvalLayer.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const response = await apiFetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    logEvent(`approval.sent: ${decision}`);
    renderApprovals(response.approvals);
  } catch (error) {
    logEvent(`approval.failed: ${error.message}`);
    renderApprovals([]);
  }
  renderEvents();
}

function setSending(isSending) {
  promptInput.disabled = isSending;
  sendButton.disabled = isSending;
  sendButton.hidden = isSending;
  stopButton.hidden = !isSending;
  // Steering (turn/steer) is Codex-only; Claude turns can be stopped but not steered.
  const isCodex = (currentThread()?.engine || "codex") !== "claude";
  steerButton.hidden = !isSending || !isCodex;
  sendButton.textContent = isSending ? "处理中" : "发送";
}

const stopButton = document.querySelector("#stopBtn");
const steerButton = document.querySelector("#steerBtn");
let activeTurnThreadId = null;
steerButton.addEventListener("click", async () => {
  if (!activeTurnThreadId) return;
  const text = await inputSheet("追加引导（发送给正在运行的任务）", {
    placeholder: "补充要求…",
    confirmLabel: "发送",
  });
  if (!text || !text.trim()) return;
  try {
    await apiFetch(`/api/threads/${encodeURIComponent(activeTurnThreadId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ text: text.trim() }),
    });
    logEvent("turn.steer.sent");
  } catch (error) {
    logEvent(`turn.steer.failed: ${error.message}`);
  }
});
stopButton.addEventListener("click", async () => {
  if (!activeTurnThreadId) return;
  stopButton.disabled = true;
  stopButton.textContent = "停止中";
  try {
    await apiFetch(`/api/threads/${encodeURIComponent(activeTurnThreadId)}/interrupt`, { method: "POST" });
    logEvent(`turn.interrupt.sent: ${activeTurnThreadId}`);
  } catch (error) {
    logEvent(`turn.interrupt.failed: ${error.message}`);
  } finally {
    stopButton.disabled = false;
    stopButton.textContent = "停止";
  }
});

function formatSendError(message) {
  if (message.includes("turn already running")) {
    return "发送失败：这个对话已有任务正在运行。请等待完成，或使用“追加引导”继续补充要求。";
  }
  if (message.includes("access token could not be refreshed")) {
    return [
      "发送失败：Codex 登录态已失效。",
      "请在终端运行 `codex login` 重新登录，然后重启 `node server.js`。",
    ].join("\n");
  }
  return `发送失败：${message}`;
}

function shortPath(value = "") {
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function compactId(value = "") {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "";
}

function statusText(status) {
  if (!status?.type) return "未加载";
  if (status.type === "active") return "运行中";
  if (status.type === "idle") return "空闲";
  if (status.type === "ready") return "就绪";
  if (status.type === "notLoaded") return "未加载";
  if (status.type === "systemError") return "异常";
  return status.type;
}

const imageViewer = document.querySelector("#imageViewer");
const imageViewerImg = document.querySelector("#imageViewerImg");

// Add a copy button to each rendered code block.
function enhanceCodeBlocks(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    button.textContent = "复制";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.innerText || "");
        button.textContent = "已复制";
        setTimeout(() => (button.textContent = "复制"), 1500);
      } catch {
        button.textContent = "复制失败";
      }
    });
    pre.append(button);
  });
}

function openImageViewer(src) {
  imageViewerImg.src = src;
  imageViewer.hidden = false;
}

function closeImageViewer() {
  imageViewer.hidden = true;
  imageViewerImg.removeAttribute("src");
}

imageViewer.addEventListener("click", closeImageViewer);
document.querySelector("#imageViewerClose").addEventListener("click", closeImageViewer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !imageViewer.hidden) closeImageViewer();
});

function logEvent(text) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  state.events.push(`${time} ${text}`);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}
