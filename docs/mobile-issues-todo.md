# Codex Web — 手机端展示问题分析与 ToDo List

> 日期：2026-06-07　设备视口：iPhone 390×844（DPR2，isMobile+hasTouch）实测
> 方法：Playwright 真机视口截图（初始/抽屉/消息/底部）+ 阅读 `styles.css` 媒体查询定位根因。

---

## 0. 一句话结论

桌面端体验已经很完整，但**手机端是"桌面三栏直接竖向堆叠"**：聊天被压在中间一小块，右侧 inspector 整块铺到下面（卡片重叠裁切），而 **topbar 的所有操作按钮在 ≤1100px 被隐藏后再没恢复 → 手机端无法重命名/归档/Fork/回滚/Review/GitDiff/技能/MCP/插件/摘要/切换主题**。抽屉（侧栏）是唯一做对的移动化部分。

---

## 1. 已确认的问题（含根因）

### A. 严重 — 功能在手机端不可达
1. **topbar 操作按钮全部消失**。`styles.css @media (max-width:1100px)` 里 `.topbar-actions .toolbar-button { display:none }`，在 ≤780px 从未恢复。受影响：重命名 ✎、压缩 ⤡、归档 🗄、**更多菜单 ⋯（Fork/回滚/Review/GitDiff/技能/MCP/插件/摘要）**、主题切换 🌙、工作区/事件视图切换。手机端这些功能**完全点不到**。
2. **「工作区 / 事件」视图切换按钮是死控件**。`script.js` 里没有任何绑定逻辑（grep 无结果），它们本应在手机端切换"聊天/事件流"视图，现在点了没反应。

### B. 严重 — 布局结构不适配手机
3. **inspector 整块竖向铺在底部**。`@media(max-width:1100px)` 先 `.inspector{display:none}`，`@media(max-width:780px)` 又 `.inspector{display:flex;max-height:520px}` 把它恢复。结果手机端把"运行/运行设置/用量/事件流"四张桌面卡片全部堆在聊天下方，需要长距离滚动。
4. **inspector 卡片重叠/裁切**。`max-height:520px` 裁住容器但内部 `<select>`/进度条溢出，实测「运行设置」与「用量」卡片视觉重叠、下拉框穿透（见底部截图）。
5. **重复且冲突的 `.workspace` / `.inspector` 规则**。`@media(max-width:780px)` 内出现两组 `.workspace`（`min-height:86vh` 与 `height:78vh;min-height:620px`）和两组 `.inspector`（520px 各一次）——抽屉改造时新增的规则与原规则叠加，行为不确定。
6. **聊天区被挤压**。workspace 固定高度 + 下方堆 inspector，导致手机端一屏只看到 2–3 条消息，聊天不是焦点。

### C. 中等 — 溢出与裁切
7. **右上「真实数据」状态 pill 被裁切**。`.topbar` 是 flex 不换行、pill `flex:0 0 auto` 不收缩，标题过长时把 pill 顶出视口右侧（初始/消息截图均可见被切）。
8. **用户消息气泡右侧被裁切**。移动端 `.bubble.user` 宽度/右侧留白导致气泡溢出视口右缘。
9. **提示词 chip 行溢出无提示**。`.prompt-toolbar{overflow-x:auto}` 可横滑，但无渐隐/滚动条提示，"图片/语音/朗读/引导"等 chip 被切在屏幕外，用户不知道可横滑。

### D. 中等 — 暗色模式在手机端失效的元素
10. **topbar 永远是白底**。`.topbar{background:rgba(255,255,255,0.94)}` 写死白色，暗色模式下 topbar 仍白，与深色 body 割裂。
11. **status-pill 边框写死浅色** `#b7e0d8`，暗色模式不协调。

### E. 中等 — 移动交互/可用性
12. **没有安全区适配**。已设 `viewport-fit=cover` 但 CSS 未用 `env(safe-area-inset-*)`，刘海屏/底部 home 指示条会遮挡 topbar 与发送区。
13. **composer 不吸底**。手机聊天习惯输入框固定底部；当前 composer 随页面滚动，发消息要先滚到底。
14. **发送按钮过大 + 空态大片留白**。空对话时整屏空白，发送按钮占用过多垂直空间。
15. **点击目标偏小**。`.toolbar-button` 32×30px、icon-button 等 < 44px 推荐触控尺寸（虽然目前在手机端被隐藏，恢复后需放大）。
16. **抽屉只能滑动关闭、不能边缘滑动打开**；遮罩之上「真实数据」pill 仍露出（z-index/层级小瑕疵）。

### F. 轻微 — 文案/细节
17. 线程副标题 **"未加载 条消息"** 文案别扭（未加载时应显示"未加载"或隐藏条数）。
18. mention 自动补全弹层、info 弹窗、审批弹框在窄屏的定位/最大宽度未单独验证，可能贴边或过宽。
19. 事件流在手机端默认展开整列，噪音大，应折叠或移到独立视图。

---

## 2. ToDo List（全量，按优先级）

### P0 · 手机端功能可达性（必修）
- [x] 恢复 topbar 操作入口 ✅ 移动端不再隐藏全部按钮；重命名/压缩/归档/主题并入 ⋯ 更多菜单（mobile-only 项），实测菜单 12 项可点。
- [x] 全部线程操作 + 主题切换在手机端经 ⋯ 菜单可点 ✅
- [x] 视图切换已实现 ✅ ☷ 按钮打开 inspector 右抽屉、遮罩/工作区关闭；不再竖向堆叠。

### P0 · 布局重构
- [x] inspector 改为右侧 off-canvas 抽屉（≤1100px），默认隐藏、☷ 唤出 ✅
- [x] inspector 卡片重叠修复 ✅ 抽屉内 `overflow:auto`、移除 max-height 硬裁，卡片完整可滚。
- [x] 清理重复冲突的 `.workspace`/`.inspector` 规则 ✅ 统一一套移动布局。
- [x] 聊天为主视图 ✅ workspace `flex:1` 占满 100dvh，页面不滚动、仅消息滚动（实测 pageScrollable=false）。

### P1 · 溢出与裁切
- [x] topbar 标题截断 + 手机端隐藏状态 pill（避免裁切）✅
- [x] 用户气泡不再裁切 ✅ max-width 82%，实测 bubbleClipped=false。
- [x] prompt-toolbar 横滑渐隐提示（右缘 mask 渐隐 + scroll-snap）✅
- [x] composer 吸底 ✅ workspace grid 底行固定 composer + `env(safe-area-inset-bottom)`，实测 composerVisible=true。

### P1 · 暗色模式补齐（手机端尤其明显）
- [x] `.topbar` 背景改 `var(--surface)` ✅ 暗色实测 rgb(22,30,33)。
- [x] `.status-pill` 边框/底色改用变量 ✅
- [x] 排查并替换写死浅色 hex（`#d2d8df`/`#edf0f2`/图片底 `#fff` → 变量）✅ 其余为语义徽章色/按钮白字，双主题可用。

### P1 · 移动交互
- [x] 安全区适配 ✅ topbar(top)、composer(bottom)、左右抽屉(left/right) 均用 env(safe-area-inset)。
- [x] 触控目标放大 ✅ 移动端 ☰/⋯/☷ 按钮 40×40，菜单项 padding 加大（实测 40x40）。
- [x] 左缘右滑打开抽屉 ✅（touchstart ≤24px + 右滑>60px）；pill 手机端隐藏，遮罩层级已无外露。

### P2 · 体验细节
- [x] 空态精简 ✅ 居中 emoji + 文案，无线程时给「＋新对话 / 打开项目对话」CTA；空对话给任务引导。
- [x] 事件流移入 inspector 右抽屉（独立视图，☷ 唤出）✅ 不再铺在聊天下方。
- [x] 文案修正 ✅ 未加载时只显示时间，不再出现"未加载 条消息"。
- [x] 弹窗窄屏适配 ✅ mention 弹层 `100vw-28px`、info/审批卡 `margin+安全区`、图片查看器/底部面板均 `min(...,100%)`，390px 实测不溢出。
- [x] 原生手势 ✅ 消息区下拉刷新（顶部下拉>70px→重载线程）+ 线程项长按 500ms 弹出底部动作面板（重命名/压缩/归档），实测面板 3 项可用。
- [x] 横屏 + ≤360px 专项验证 ✅ 360/390/412/844 实测均无横向溢出、零 JS 错误。
- [x] 键盘适配 ✅ 监听 visualViewport.resize → `--vvh`，app-shell 用 `var(--vvh,100dvh)` 随键盘收缩，composer 不被遮挡。

### P2 · 验证基建
- [x] 移动视口回归 ✅ `scripts/mobile-check.mjs`（360/390/412/横屏，断言无溢出/无错误/核心控件存在）+ `npm run test:mobile` + CI 新增 mobile job。
