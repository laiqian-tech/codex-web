# Codex Web — Android 端第二轮问题分析与 ToDo List

> 日期：2026-06-10　设备视口：Pixel 7 412×915（DPR2.6，isMobile+hasTouch，Android UA）实测
> 方法：Playwright Android 视口探测（键盘模拟 / 横屏 / 菜单测量 / computed style）+ 通读 `styles.css`、`script.js`、`manifest.webmanifest`、`sw.js`。
> 上一轮（iPhone 390 视口）见 [mobile-issues-todo.md](./mobile-issues-todo.md)，已全部完成。

---

## 0. 一句话结论

上一轮把"桌面三栏"成功改成了"手机单栏 + 双抽屉"，但 **Android 实测仍有一个隐藏的 P0：`.app-shell` 基础规则里的 `min-height: 680px` 在手机媒体查询中从未重置**——键盘一弹出（视口 ≈500px）shell 仍保持 680px，composer 被键盘整个盖住，所谓 `--vvh` 键盘适配实际失效；横屏（844×390）整页可滚、输入框不可见。另有一批 Android 特有问题：不跟随系统暗色、原生下拉刷新冲突、`window.prompt` 弹窗、WebAPK 安装缺 PNG 图标等。

---

## 1. 已确认的问题（含根因与实测证据）

### A. 严重 — 布局在键盘/横屏下崩坏
1. **键盘弹出后 composer 被遮挡**。`styles.css` 基础规则 `.app-shell{min-height:680px}`，`@media(max-width:780px)` 改了 `height:var(--vvh,100dvh)` 但没重置 min-height。实测把 `--vvh` 设为 500px 后 shell 仍是 680px，composer bottom=680 > 视口 500。
2. **横屏不可用**。844×390 时宽度落在 781–1100 区间（平板布局），`min-height:680` 导致 `pageScrollable=true`、`composerVisible=false`，整个输入区在屏幕外。
3. **⋯ 更多菜单可能溢出屏幕**。菜单 12 项实测高 494px、无 `max-height`/滚动；竖屏 915px 勉强放下，横屏 390px 直接溢出且无法滚到底部项。

### B. 严重 — 核心交互反直觉
4. **流式回复期间无法上滑回看**。`renderMessages()` 每收到一个 SSE delta 就全量重渲染并强制 `messageList.scrollTop = scrollHeight`，长回复输出期间用户手指一松就被拽回底部。应只在"本来就贴近底部"时自动跟随。
5. **自定义下拉刷新与 Android Chrome 原生下拉刷新冲突**。`.messages`/`body` 的 `overscroll-behavior` 均为默认 `auto`，顶部下拉同时触发自定义刷新和浏览器整页刷新。
6. **重命名 / 追加引导 / 归档 / 回滚用 `window.prompt`/`window.confirm`**。Android PWA（WebAPK）里是原生半屏 alert，无中文按钮定制、输入体验差，且部分 WebView 直接返回 null。

### C. 中等 — Android 平台适配缺失
7. **不跟随系统暗色模式**。无保存主题时强制 `light`（实测 `prefers-color-scheme: dark` 下 `data-theme=light`），Android 夜间一片白。
8. **`<meta name="theme-color">` 写死 `#16806f`**。切到暗色主题后 Android 地址栏/任务卡片仍是亮绿色，与深色界面割裂。
9. **manifest 只有 SVG 图标**。Android WebAPK 安装要求 192/512 PNG，纯 SVG 时安装提示可能不出现或图标渲染为默认占位。
10. **输入法体验**：textarea 无 `enterkeyhint`（键盘右下角不显示"发送"），placeholder 写"按 Ctrl/Cmd + Enter 发送"（手机无意义），`resize: vertical` 在触屏上是无效控件且占视觉。
11. **PWA 状态栏遮挡抽屉**。左右抽屉 `top:0` 且 `padding-top:12px` 无 `env(safe-area-inset-top)`，standalone 模式下内容顶进状态栏。

### D. 中等 — 可见性/触控
12. **手机端看不到连接状态**。status pill `display:none`，Mock 模式 / 真实数据 / 同步中状态在手机上完全不可见，连不上后端时用户毫无感知。
13. **侧栏图标按钮 28×28**（同步 ↻ / 新对话 + / 重载 ⟳），低于 Android 48dp 建议，误触率高。
14. **线程长按与 contextmenu 双触发**。Android 长按既走 500ms 定时器又触发 `contextmenu`，`openThreadActions` 被调用两次（动作面板重复渲染）。

### E. 轻微 — 回归基建
15. `scripts/mobile-check.mjs` 只查横向溢出，没查**纵向溢出/composer 可见性/键盘模拟/菜单溢出**——所以问题 1/2 一直没被 CI 抓到。

---

## 2. ToDo List（按优先级）

### P0 · 键盘与横屏布局（必修）
- [x] 1. 手机/平板媒体查询重置 `.app-shell` min-height ✅ `--vvh=500` 实测 shell=500、composerBottom=500（可见）
- [x] 2. 横屏 844×390 ✅ 实测 `pageScrollable=false`、`composerVisible=true`
- [x] 3. ⋯ 更多菜单 `max-height:min(480px,100dvh-90px)` + 内部滚动 ✅ 实测高度 480 截断可滚

### P0 · 核心交互
- [x] 4. 流式输出贴底才跟随 ✅ 实测上滑后重渲染 `scrollTop` 保持 0、贴底时仍自动跟随；发送自己的消息仍强制滚底
- [x] 5. overscroll 屏蔽 ✅ `.messages` contain、`html/body` none，自定义下拉刷新保留

### P1 · Android 平台适配
- [x] 6. prompt/confirm 全部替换为底部面板 ✅ 重命名/引导=输入面板，归档/回滚=确认面板；实测无原生 dialog 弹出
- [x] 7. 跟随系统暗色 ✅ dark scheme 实测 `data-theme=dark` 且不写入存储（继续跟随系统），手动切换才固化
- [x] 8. theme-color 动态 ✅ 暗色 `#161e21`、亮色 `#ffffff`，与 topbar 表面色一致
- [x] 9. PNG 图标 ✅ `scripts/gen-icons.mjs`（零依赖 PNG 编码）生成 192/512，manifest 加 any+maskable，sw 缓存 v3
- [x] 10. 输入法 ✅ `enterkeyhint=send`、触屏 placeholder"给 Codex 一个任务…"、触屏 Enter 直接发送、自动增高（实测封顶 150px）、去 resize 手柄
- [x] 11. 抽屉顶部安全区 ✅ 左右抽屉 `padding-top: calc(12px + env(safe-area-inset-top))`

### P1 · 可见性/触控
- [x] 12. 连接状态圆点 ✅ 28px 触控/12px 视觉，绿=在线、橙=Mock、灰闪=忙碌；点按弹出来源+后端地址详情
- [x] 13. 侧栏 icon-button ✅ 移动端 40×40 实测
- [x] 14. 长按互斥 ✅ 定时器与 contextmenu 都走 openOnce 守卫，实测面板只渲染一次；顺带给全部触摸手柄加了空 touches 保护

### P2 · 回归基建
- [x] 15. `mobile-check.mjs` 强化 ✅ 新增纵向溢出 / composer 可见 / 键盘模拟（--vvh=500 断言 composer 不被遮）/ ⋯ 菜单溢出 4 类断言（横屏视口在修复前会命中其中 2 条）
- [x] 16. 全量回归 ✅ `npm test` 58/58 通过、`npm run check` 通过、`npm run test:mobile` 4 视口全过；桌面 1440×900 三栏布局无回归

---

## 3. 本轮改动摘要

- `styles.css`：≤1100px 重置 `.app-shell` min-height；菜单限高滚动；overscroll 屏蔽；sheet 输入框/确认样式；状态圆点；移动端 icon-button 40px；抽屉顶部安全区；textarea 去 resize 手柄
- `script.js`：贴底才跟随滚动；sheet 升级支持输入/确认 Promise（替换全部 prompt/confirm）；系统暗色跟随 + 动态 theme-color；触屏 placeholder/Enter 发送/自动增高；`setConnStatus` 状态色调 + 点按详情；长按互斥；触摸事件空值保护
- `index.html`：`enterkeyhint=send`、apple-touch-icon 指向 PNG
- `manifest.webmanifest` / `sw.js`：新增 192/512 PNG（any+maskable）、缓存升级 v3
- 新增 `scripts/gen-icons.mjs`（零依赖 PNG 图标生成）；`scripts/mobile-check.mjs` 增加 4 类回归断言
