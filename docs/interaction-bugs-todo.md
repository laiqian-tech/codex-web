# Codex Web — 交互/功能 Bug 清单与修复（用户视角实测）

> 日期：2026-06-17　方法：Playwright 桌面+移动视口实操两种引擎对话 + 直连 API 对照 + 通读 script.js/server.js。
> 触发：双引擎上线后，从真实用户操作路径找交互/功能 bug。

## 根因证据

- `/api/account` 首次返回 **500**（codex app-server 冷启动竞态），之后 200；但 `loadAccount()` 只在 `syncFromBackend` 跑一次且 catch 后隐藏卡片 → **整场会话用量都不显示**。
- 用量数据是 ChatGPT 账号额度（`plus`，`windowDurationMins:43200`=30 天），**与所选模型/引擎无关**，对 Claude 对话更无意义——这就是"切模型用量不变"的根因。
- 用量窗口标签硬编码 "5 小时窗口/7 天窗口"，与真实窗口时长不符。
- Codex 新对话标题永远 "未命名对话"（`normalizeThread` 默认值），`sendPrompt` 只在标题等于 "新对话" 时才用首条消息改名。

## ToDo List

### P0 · 功能错误
- [x] 1. 用量卡片整场不显示 ✅ `loadAccount` 退避重试（穿过冷启动 500）+ 每轮后刷新；实测 Codex 用量卡正常显示。
- [x] 2. 用量随引擎联动 ✅ Claude 对话隐藏 ChatGPT 用量卡；发完一轮显示"Claude · 本轮 耗时 10.1s · 花费 $0.0582"；切引擎即刷新。
- [x] 3. 用量窗口标签动态 ✅ 按 `windowDurationMins` 计算，实测显示"30 天窗口"（原写死"5 小时窗口"）。
- [x] 4. Codex 新对话标题 ✅ 标题为空/占位（"新对话"/"未命名对话"）时用首条消息命名。

### P1 · 状态不反映引擎
- [x] 5. "来源"显示引擎友好名 ✅ 实测 Codex→"Codex"、Claude→"Claude"，随对话切换。
- [x] 6. Claude 未首轮状态 ✅ 显示"就绪"（新增 `ready` 状态映射），不再"未加载"。
- [x] 7. 运行设置 Claude 下禁用 ✅ 推理强度/审批/沙箱 `disabled`（实测 effortDisabled=true）。

### P2 · 一致性
- [x] 8. 搜索并入 Claude ✅ `crossThreadSearch` 客户端匹配本地 Claude 对话并入结果。
- [x] 9. Claude 每轮耗时/成本 ✅ server 回传 `lastTurn{durationMs,costUsd}` → 用量卡展示；agent 头部仍显示耗时。

### 验证
- [x] 10. 回归 ✅ `npm test` 77/77、`npm run check`、`npm run test:mobile` 全过；浏览器复测两引擎运行面板正确联动，零 JS 错误。

---

## 第二轮审计（深层边角）

> 方法：通读未细查的流程（停止/中断、SSE、PWA、附件、切换引擎）+ 代码路径核对。

### P0 · 部署/缓存
- [x] R1. **PWA 缓存陈旧** ✅ `sw.js` 改 network-first（在线取最新并回填缓存、离线回退），CACHE 升 v4 → 发布后不再拿旧 JS/CSS。

### P1 · 停止/附件一致性
- [x] R2. **停止 Claude 优雅化** ✅ engine 记中断标记，close 时优雅 resolve（不 reject）；实测停止显示"（已停止）"，showsError=false。
- [x] R3. **Claude 图片附件防御** ✅ Claude 对话隐藏 📎（实测 display:none，切回 Codex 恢复）；sendPrompt 对 Claude 丢弃 images 避免空 prompt。

### P2 · 细节
- [x] R4. **切换引擎上下文收敛** ✅ 仅取最近 12 轮、上限 6000 字（单测覆盖：丢旧留新）。

### 验证
- [x] R5. 回归 ✅ `npm test` 78/78、`npm run check`、`npm run test:mobile` 全过；浏览器复测停止/附件均符合预期，零 JS 错误。
