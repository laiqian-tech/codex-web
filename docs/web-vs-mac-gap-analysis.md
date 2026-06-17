# Web 版 Codex vs Mac 版 Codex — 差异分析与 ToDo List

> 生成日期：2026-06-05　基于 codex-cli 0.134.0 / app-server 实测
> 方法论：直连 `codex app-server` 探测协议能力面，对比当前 Web 客户端实现。

---

## 0. 一句话结论

Web 版目前是一个**「只读+单轮文本对话」的轻量壳**：能同步项目/线程、续聊、发纯文本任务、看最终回复。
而 app-server 实际暴露了 **100+ 个方法**，Web 端只用了 **6 个**；持久化的 **7 种消息 item** 里 Web 只渲染了 **2 种**。
Mac 版的核心体验（流式输出、推理过程、命令执行/diff、审批、打断、附件、模型设置、用量）几乎**全部缺失**。

---

## 1. 当前 Web 版已具备的能力

- 项目列表（按 cwd 聚合）+ 对话列表，二者均可搜索
- 续聊已有线程 / 新建线程 / 重载线程
- 发送纯文本任务（`turn/start`），轮询 `/api/events` 看事件流
- 右侧运行态卡片（来源/线程/状态/消息数）+ 原始事件流
- 消息区：用户右侧气泡、连续 Codex 合并表头、图片缩略图+全屏查看（本次新增）
- localStorage 持久化 + 后端不可用时回退 mock
- 健康检查、CORS、静态资源服务、路径穿越防护

## 2. app-server 能力面（实测）

**Web 端已用的方法（6）**：`initialize` · `thread/list` · `thread/read` · `thread/start` · `thread/resume` · `turn/start`

**完全未用的关键方法（节选）**：
- 轮次控制：`turn/steer`（中途引导）、`turn/interrupt`（打断/停止）
- 审批：服务端→客户端的审批 elicitation（**当前未处理，见 §5 严重 bug**）
- 评审：`review/start`（Code Review 模式）
- 上下文：`thread/compact/start`（压缩）、`getConversationSummary`
- 线程管理：`thread/fork` · `thread/rollback` · `thread/archive`/`unarchive` · `thread/name/set` · `thread/search`
- 模型/设置：`model/list`（实测可用，返回 GPT-5.5 及 low/medium/high reasoning effort）、`thread/settings/update`、`permissionProfile/list`、`collaborationMode/list`、`experimentalFeature/list`
- 账号/用量：`account/read` · `account/rateLimits/read` · `getAuthStatus` · `account/login/start`
- 技能/插件/市场：`skills/list` · `plugin/*` · `marketplace/*`
- MCP：`mcpServerStatus/list` · `mcpServer/tool/call` · `mcpServer/resource/read`
- 文件/Git：`fs/*` · `gitDiffToRemote` · `fuzzyFileSearch`（@ 文件引用）
- 实时语音：`thread/realtime/*`
- 远程控制：`remoteControl/*`

**持久化的 item 类型（7，实测 100 线程）**：
`userMessage` ✅渲染 · `agentMessage` ✅渲染 · `webSearch` ❌丢弃 · `fileChange`(diff) ❌丢弃 · `mcpToolCall` ❌丢弃 · `imageGeneration` ❌丢弃 · `contextCompaction` ❌丢弃
> 此外 live turn 期间还有 `commandExecution`/`reasoning`/`todoList` 等通过 `item/started`·`item/completed` 通知流出，Web 端仅处理了 `item/agentMessage/delta`。

## 3. 功能差异（Web 缺失 / Mac 有）

| 能力 | Mac 版 | Web 版现状 |
|---|---|---|
| 流式 token 输出 | ✅ 逐字 | ❌ 后端攒完整段再一次性返回（最长等 10 分钟） |
| 推理过程 (thinking) | ✅ 可展开 | ❌ 不显示 |
| 命令执行 + 输出 + 退出码 | ✅ 折叠卡片 | ❌ 不显示 |
| 文件改动 diff | ✅ 行级高亮 | ❌ `fileChange` 被丢弃 |
| 审批（命令/补丁/网络） | ✅ Allow/Deny | ❌ 无处理 → **挂起**（§5） |
| 打断 / 停止 | ✅ Stop | ❌ 无（只能等超时） |
| 中途引导 (steer) | ✅ | ❌ |
| 图片/文件附件 | ✅ 粘贴/拖拽 | ❌ 输入仅纯文本 |
| @ 文件引用 | ✅ fuzzy search | ❌ |
| 斜杠命令 / 技能 | ✅ | ❌ |
| Markdown / 代码高亮 / 复制 | ✅ | ❌ 纯文本 `textContent` |
| 模型 / reasoning effort / sandbox / 审批策略 选择 | ✅ | ❌ 硬编码 `on-request`+`workspace-write` |
| Token 用量 / 上下文窗口 / 速率限制 | ✅ | ❌ |
| Code Review 模式 | ✅ | ❌（仅有提示词 chip） |
| 线程 重命名/归档/删除/Fork/回滚 | ✅ | ❌ |
| 跨线程搜索 | ✅ `thread/search` | ❌（仅本地标题过滤） |
| 上下文压缩 | ✅ | ❌ |
| MCP 服务器状态/工具 | ✅ | ❌ |
| 实时增量更新（无需手动刷新） | ✅ | ❌ 轮询，需手动重载 |
| 语音模式 | ✅ | ❌ |
| 账号/登录态 | ✅ | ❌（仅靠 CLI 已登录） |

## 4. UI / 界面差异

- **无 Markdown 渲染**：代码块、列表、表格、链接全是纯文本，长代码不可读、无复制按钮、无语法高亮。
- **无富消息类型**：命令卡片、diff、工具调用、web 搜索、推理块都看不到，对话失去"工作流"质感。
- **无逐条时间戳 / 耗时 / token**：`turn` 有 `durationMs`、`status`、`error` 字段，未利用。
- **无加载/流式态**：发送后只有一句"Codex 正在处理…"占位，无进度、无打断按钮。
- **事件流是全局共享**：所有客户端/线程共用一份 `codex.events`，非按线程隔离，多端会串。
- **无空态/错误态设计**：错误仅一行文本。
- **无暗色模式、无 PWA/可安装、无移动端手势**（侧栏抽屉、下拉刷新等）。
- **可访问性**：图片查看器无 focus trap、列表无键盘导航、aria 不完整。

## 5. 不足与隐患（按严重度）

**P0 — 正确性 / 安全**
1. **审批挂起 bug**：`approvalPolicy:"on-request"` 下，服务端会发"请求审批"的反向 request（带 `id`+`method`）。`server.js#handleLine` 把任何带 `id` 的消息都当成"响应"处理，找不到 pending 就静默丢弃，永不回复 → **Codex 轮次卡死直到 600s 超时**。凡触发命令/补丁/网络审批的任务都会中招。
2. **无鉴权 + CORS `*`**：定位是"手机网页"，一旦 `HOST=0.0.0.0` 暴露到局域网，任何人可读所有项目/线程、可在你机器上跑 `workspace-write` 任务。无 token、无鉴权、无 HTTPS。
3. **单后端进程 + 共享 waiter**：`turnWaiters` 按 (threadId,turnId) 匹配，多线程并发或多端同时发会串台；`findTurnWaiter` 在 turnId 未知时按 threadId 模糊匹配，易错配。

**P1 — 体验 / 数据**
4. 无流式 → 长任务前端长时间无反馈、易被当作卡死。
5. `fileChange`/`webSearch`/`mcpToolCall`/`imageGeneration` 等 item 全丢弃 → 历史信息不完整。
6. 图片用 base64 data URL 内联，整线程随 `thread/read` 全量返回 → 大线程响应体巨大、慢。
7. 轮询 `/api/events`（2s）而非 SSE/WebSocket → 延迟高、无法逐字。
8. 无打断 → 发错了只能等超时。

**P2 — 工程 / 可维护**
9. 无测试、无 lint/format 配置、无 package.json（裸 node）。
10. mock 与真实状态切换逻辑散落，`ui.dataSource` 等状态易不一致。
11. 无日志落盘、无错误上报。

---

## 6. ToDo List（全量，按优先级 + 分类）

### P0 · 必修（正确性 / 安全）
- [x] **修复审批挂起**：在 `handleLine` 中区分"服务端响应"(`id` 且无 `method`) 与"服务端反向请求"(`id` 且有 `method`)；为审批/elicitation 请求实现回复通道，前端弹 Allow/Deny。✅ `protocol.js` `classifyMessage` + `server.js` `handleServerRequest`/`respondApproval`，覆盖 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`；未知反向请求回 -32601 错误防挂起。15 个单测/集成测试通过。
- [x] **审批 UI**：命令审批、文件改动审批的前端确认框（命令/目录/原因预览 + 允许/本会话允许/拒绝/拒绝并中断）。✅ `/api/approvals` 轮询 + `renderApprovals` 弹框，Playwright 验证渲染与回传闭环。
- [x] **接入鉴权**：✅ opt-in Bearer token（`AUTH_TOKEN`），`/api/*` 全保护、`/health` 与静态资源开放；前端令牌输入框 + localStorage 持久化；CORS 经 `ALLOW_ORIGIN` 可收紧、放行 `Authorization` 头；绑非回环且无 token 时启动告警。HTTPS 走反代（README 已说明）。17 测试通过 + curl 端到端验证 401/200。
- [x] **并发隔离**：✅ `protocol.js` `matchWaiter` 精确 turnId 优先；turnId 已知但无人认领时仅唯一未识别 waiter 可接管；通知无 turnId 时仅当线程上唯一 waiter 才匹配，否则不猜 → 杜绝并发轮次串台。单测覆盖 4 种场景。
- [x] **事件流按线程隔离**：✅ 事件带 `threadId` 标签，`eventsFor(threadId)` 返回"本线程 + 系统事件"，`/api/events?threadId=` 与各端点按线程过滤；多端/多线程不再互看噪音。集成测试 + Playwright 验证。

### P1 · 核心体验（对齐 Mac 主流程）
- [x] **流式输出**：✅ SSE 端点 `/api/stream?threadId=`（fetch streaming 支持鉴权头），服务端广播 `delta`/`turnStarted`/`turnCompleted`/`fileChange`，按 threadId 过滤；前端 `streamTurn` 逐字追加到 pending 消息。2 订阅单测 + 真实轮次端到端验证（turnStarted→delta→turnCompleted）。附带修复"新建线程立即发送因 thread/resume 无 rollout 报错"——resume 改为尽力而为。
- [x] **打断 / 停止**：✅ `interruptTurn` 发 `turn/interrupt`（按活跃 turnId）；`POST /api/threads/:id/interrupt`；发送态显示红色"停止"按钮，点击中断当前轮次。2 集成测试 + Playwright 验证端点契约与按钮显隐。`request` 超时计时器加 `unref`。
- [x] **中途引导**：✅ `turn/steer`（按活跃 turnId）+ `/api/threads/:id/steer`；发送态显示 ↪引导 按钮。
- [x] **Markdown 渲染**：✅ 无依赖、XSS 安全的 `markdown.js`（转义优先；代码块/内联代码/粗斜体/标题/有序无序列表/引用/安全链接，仅放行 http/https/mailto）；代码块带"复制"按钮；11 个单测含 XSS 与数字占位符回归。Playwright 实测渲染 169 段、7 代码块/复制钮、155 列表项。（语法高亮用深色主题代码块，未做 token 级高亮）
- [x] **富消息类型渲染**（持久化 + live 流式均完成；commandExecution/reasoning 经 SSE item 事件实时插入，Playwright 实测 exit 0 命令块）（原注：持久化类型；`transcript.js` `itemToMessage` + 前端 `buildEvent`，9 单测；Playwright 实测渲染 44 事件/29 文件改动/14 工具调用）：
  - [x] `commandExecution`：✅ live 流式渲染，命令 + exit 码（绿/红）+ 折叠输出 + 耗时
  - [x] `fileChange`：✅ 文件列表 + 增删统计 + 可展开行级 diff（绿增红删）
  - [x] `webSearch`：✅ 查询列表
  - [x] `mcpToolCall`：✅ server/tool/状态/耗时/标题
  - [x] `reasoning`：✅ live 流式渲染为可展开「💭 推理过程」块（Markdown）
  - [x] `imageGeneration` / `contextCompaction`：✅ 生成图片网格 / 压缩标记
- [x] **推理过程显示**（thinking，折叠）✅ reasoning item 渲染为可折叠推理块。
- [x] **图片附件**：✅ 📎 选图 + 粘贴上传，缩略图预览可删除；`turn/start` input 带 `{type:"image",url:data}`；`sanitizeImages` 仅放行 data:image/ 且限 6 张（3 单测）。Playwright 验证选图/删除/pendingImages 同步。（拖拽与本地路径 localImage 待做）
- [x] **@ 文件引用**：✅ composer 输入 @query 触发 `fuzzyFileSearch` 自动补全下拉，选中插入路径。Playwright 验证。
- [x] **模型 & 运行设置**：✅ `/api/models`（接 `model/list`，返回 GPT-5.5/5.4/5.4-mini + efforts）；UI 选择器（模型/推理强度/审批策略/沙箱）持久化 localStorage，随 `turn/start` 与 `thread/start` 下发；`sanitizeSettings` 按 schema 枚举校验防注入（4 单测）。Playwright 验证面板填充与持久化。
- [x] **Token 用量 / 速率限制**：✅ `/api/account`（合并 `account/read` + `account/rateLimits/read`）；用量卡片显示账号/套餐 + 5 小时/7 天窗口进度条（≥70% 黄、≥90% 红）+ 重置时间。Playwright 验证渲染。（上下文窗口 token 数待流式 turn 元数据）

### P1 · 线程管理
- [x] 重命名（`thread/name/set`）✅、归档（`thread/archive`）✅、**Fork**（`thread/fork`）✅、**回滚**（`thread/rollback`）✅。topbar 按钮（重命名/压缩/归档）+ 更多菜单（Fork/回滚）。
- [x] 跨线程搜索（`thread/search`）✅ 对话搜索框≥2 字触发跨项目搜索（`searchTerm`），点结果自动切项目+线程。实测搜"美股"返回 25 条。
- [x] 上下文压缩（`thread/compact/start`）✅ 入口（topbar 按钮 + 事件提示）。
- [x] 轮次耗时 / 状态展示。✅ `extractMessages` 把 `turn.durationMs`/`status` 附到该轮最后一条 agent 消息，表头显示「Codex · 75.2s」。实测 58 表头 23 条带耗时。（逐条精确时间戳待 item 级元数据）

### P2 · 进阶能力
- [x] Code Review 模式（`review/start`）✅ 更多菜单「Review 当前改动」对 uncommitted 发起评审。
- [x] 技能列表（`skills/list`）✅ 更多菜单「查看可用技能」弹窗（实测 96 项）。
- [x] 插件 / 市场 ✅ `/api/plugins`（`plugin/list`）更多菜单「查看插件」列出 179 插件含市场/安装状态；技能/MCP 亦可查看。（install/uninstall 管理为进阶）
- [x] MCP 服务器状态（`mcpServerStatus/list`）✅ 更多菜单「查看 MCP 服务器」列出服务器+工具数。
- [x] Git diff 视图（`gitDiffToRemote`）✅ 更多菜单「查看 Git Diff」弹窗，绿增红删高亮。
- [x] 登录态 / 账号（`getAuthStatus` + `account/read`）✅ 用量卡片显示邮箱/套餐；`/api/authstatus` 端点就绪。
- [x] 语音模式 ✅ Web Speech API 语音输入（zh-CN 听写→填入输入框）+ SpeechSynthesis 朗读 Codex 回复；🎤/🔈 按钮，`listVoices` 可用。Playwright 验证控件+浏览器 API。（完整服务端 `thread/realtime/*` 音频流为可选进阶路径）
- [x] 会话摘要（`getConversationSummary`，参数 `conversationId`）✅ 更多菜单「查看会话摘要」展示预览/分支/CLI 版本/更新时间。端点验证通过。

### P2 · UI / 移动端 / 工程
- [x] 暗色模式。✅ `:root[data-theme=dark]` 变量覆盖 + topbar 🌙/☀️ 切换，localStorage 持久化；shell/卡片/输入区/Markdown 全主题化。Playwright 验证切换。
- [x] PWA。✅ `manifest.webmanifest` + `sw.js`（离线缓存壳，API 不缓存）+ SVG 图标 + 注册；Playwright 确认 SW 已注册。（推送通知待做，需 HTTPS）
- [x] 移动端手势。✅ 侧栏改为 off-canvas 抽屉（汉堡切换 + 遮罩 + 选中后关闭 + 左滑关闭）；实测 390px 下滑入/滑出。（下拉刷新/长按菜单待做）
- [x] 空态 / 加载骨架。✅ 读取线程时显示 shimmer 骨架，空对话/未选择有空态文案；错误以 info 弹窗呈现。
- [x] 可访问性（部分）。✅ 弹窗 focus trap + Esc 关闭 + 打开聚焦关闭钮；图片查看器 Esc/点遮罩关闭；aria-label 补充。（列表键盘导航待做）
- [x] 大线程性能：✅ 图片走 `/img/<id>` 缓存端点（实测线程响应 2MB→121KB）；消息窗口化（只渲染最近 60 条 + 「显示更早」按钮，实测 242 条线程）。（完整虚拟滚动/turns 分页待做）
- [x] 工程化：✅ `package.json` + `node:test`（53 测试）+ `npm run check/lint`（全 JS node --check）+ GitHub Actions CI（`.github/workflows/ci.yml`）+ `.editorconfig`/`.prettierrc`/`.gitignore`。
- [x] 日志落盘。✅ `logs/server.log` 追加错误日志（`logToFile`），500 路径记录 stack。（外部错误上报 SaaS 待接）
