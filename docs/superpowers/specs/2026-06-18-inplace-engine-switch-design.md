# 设计：同一对话内原地切换引擎（Codex ⇄ Claude）

> 日期：2026-06-18　状态：方向已批准，待 spec 复审

## 目标
在同一个对话里切换 Codex / Claude，不再每次切换都新建对话。切换后保持同一对话 id 与同一条连续历史，新引擎自动接上之前的上下文。

## 范围（已确认）
- **仅对 web 新建的对话**生效。
- Mac app 同步来的 Codex 线程（来自 `thread/list`，id = 原生 threadId、无逻辑包装）**维持现状**：切换仍 fork 新对话。
- 衔接方式：**自动带上**——切换后下一轮由服务端把上下文前缀静默喂给新引擎，输入框不再被塞入大段文本。
- 优化：**切回某引擎时只重放"离开它之后的增量"**，把未命中缓存的新 token 降到最低。

## 缓存影响（为什么不降命中率）
统一的 `conv.messages` 只是本地显示用，不作为 prompt 重发。真正发给模型的仍是"继续原生会话（`--resume`/`thread/resume`）+ 本轮新消息"：
- 同引擎连续 → 复用同一原生会话前缀，命中行为与现状一致。
- 切回用过的引擎 → resume 原会话（TTL 内前缀仍热）→ 命中；优于现状（fork 每次冷启动）。
- 切换瞬间的增量重放是新 token、不命中，但仅**追加在已缓存前缀之后**，不使其失效；这是跨引擎交接的固有成本。

## 数据模型：convStore（由 claudeStore 泛化而来）
web 新建对话存为逻辑记录（持久化到 `claude-threads.json`，沿用文件名以兼容）：
```
{
  id: "conv-<hex>",                 // 稳定 web id（不再用原生 id 当 web id）
  engine: "codex" | "claude",       // 当前引擎
  codexThreadId: string | null,     // 各引擎原生会话，懒启动后回填
  claudeSessionId: string | null,
  cwd, title, updatedAt,
  messages: [],                     // 统一消息流：唯一显示事实源
  lastTurn: { durationMs, costUsd } | null,
  rateLimit: object | null,
  pendingSeed: string | null,       // 切换后下一轮要带的上下文前缀
  engineCursor: { codex: int, claude: int }  // 各引擎"上次离开时"的 messages 长度
}
```
路由判定从 `isClaude(id)` 改为 `convStore.has(id)` + 看 `conv.engine`。

### 迁移
旧 `claude-threads.json` 记录 `{id:"claude-…", nativeId, …}` 读取时映射：`claudeSessionId = nativeId`、`engine="claude"`、`codexThreadId=null`、`engineCursor={}`。向后兼容，旧对话照常工作。

## 新建对话
`POST /api/threads { engine, cwd }` → 建 convStore 记录（id=`conv-…`，engine 设定，两个原生 id 都为 null），**不立即起原生会话**（懒启动，与现 Claude 路径一致）。

## 发消息（统一转写）
`POST /api/threads/:id/turns`：
- 若 `convStore.has(id)` → 按 `conv.engine` 路由：
  1. 把用户消息追加进 `conv.messages`。
  2. 若有 `pendingSeed`，本轮把它作为上下文前缀拼到用户文本前（仅这一轮），随后清空。
  3. **claude**：`runClaudeTurn`（懒启动捕获 `claudeSessionId`），把工具事件 + 回复追加进 `conv.messages`（现有逻辑）。
  4. **codex**：`codexThreadId` 为空则先 `startThread` 回填；`resume`+`runTurn`；turn 完成后 `readThread`，**取最后一个 turn 的非 user 项**（`itemToMessage`）追加进 `conv.messages`（用户消息已在步骤 1 加过，避免重复）。
- 否则（Mac app 线程）→ 现有 codex 路径不变。

统一消息流让两个引擎的回合显示为一条连续历史；流式 SSE 仍按现有机制把 delta/item 推给前端实时渲染。

## 原地切换
`POST /api/threads/:id/switch-engine { to }`：
- 不在 convStore（Mac app 线程）→ 回退到现有 fork 行为。
- 在 convStore：
  - `conv.engine === to` → no-op。
  - 计算增量：`delta = conv.messages.slice(conv.engineCursor[to] ?? 0)`。
    - 首次切到该引擎：cursor 未设 → `slice(0)` = 全部历史；`buildReplayPrompt` 内部再截最近 12 轮/≤6000 字。
    - 切回用过的引擎：cursor 已设 → delta 仅为离开后的新增（通常很少）。
    - 单一表达式对两种情况都成立，因为 `buildReplayPrompt` 始终只取末尾最近 12 轮。
  - `conv.pendingSeed = buildReplayPrompt(delta)`（delta 为空则不设，跳过重放）。
  - `conv.engineCursor[conv.engine] = conv.messages.length`（记下离开当前引擎的位置）。
  - `conv.engine = to`；id 与 messages 不变；持久化。
- 返回更新后的对话（**不新建**）。

## 同步去重
`/api/sync` 合并 convStore 记录 + codex `thread/list`。convStore-codex 的 `codexThreadId` 也会出现在 `thread/list` 里 → 过滤掉 id ∈ {convStore 各 codexThreadId} 的 codex 线程，避免重复显示。

## 客户端
- 输入框上方的 Codex/Claude 分段器：对 convStore 对话点击 → 调原地 `switch-engine`，**仅翻转引擎并重渲染，不 unshift 新对话、不塞输入框**；对 Mac app 线程 → 维持现有 fork+seed 行为。
- 引擎角标、运行面板"引擎"单元格、⋯ 菜单 codex-only 项均按 `thread.engine` 已联动，无需大改。
- 新建对话仍走引擎选择（"+"）或直接用分段器在空对话上选。

## codex-only 操作路由
fork/rollback/review/gitdiff/summary/skills/mcp/compact 对 convStore-codex 对话需用 `conv.codexThreadId` 调用；服务端这些路由解析 `id→codexThreadId`（无则提示"先发一条消息以建立会话"）。claude 引擎下这些项前端已隐藏。

## 错误处理
- 切换到的引擎首轮失败：保留 `pendingSeed` 以便重试；`conv.engine` 已切换（用户可重发）。
- codex 懒启动 `startThread` 失败：turn 报错，按现有 `formatSendError`。
- 迁移读取异常：跳过坏记录，不阻断启动。

## 测试
- 单测：convStore 迁移（旧 claude 记录→新结构）、switch-engine 增量游标计算（首次取最近 N、切回取 delta、来回切游标正确）、sync 去重过滤。
- 端到端（浏览器/API）：web 新建 Codex 对话发一轮 → 原地切 Claude → 同一 id、历史连续、Claude 接上上下文 → 切回 Codex resume 原会话；确认列表不新增条目、无重复。
- 回归：`npm test` / `npm run check` / `npm run test:mobile` 全过。

## 非目标
- 不改 Mac app 同步线程的切换行为（仍 fork）。
- 不做跨引擎的工具调用/diff 迁移（仅文本上下文）。
- 不引入新依赖。
