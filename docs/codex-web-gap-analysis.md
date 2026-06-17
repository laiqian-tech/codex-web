# Codex Web 与 Mac Codex 差异分析

分析日期：2026-06-05

## 结论

当前项目是一个可运行的本机 Codex Web 原型，不是完整的 Codex Web 客户端。
它已经证明了三个核心链路可行：通过 Node 代理启动 `codex app-server`、同步本机项目与线程、
继续已有线程。但它目前更接近“线程查看器 + 文本发送器 + 原始事件面板”，距离 Mac Codex
的多 Agent 工作台仍有较大差距。

最优先的问题不是视觉，而是协议完整性与安全性：

1. 服务端没有处理 `app-server` 发起的审批和用户输入请求。任务遇到命令执行、文件修改、
   权限升级、MCP elicitation 等情况时可能挂起直到超时。
2. API 没有身份认证、授权和工作区边界校验。如果通过 `HOST=0.0.0.0`、端口转发或反向代理
   暴露出去，访问者可操作本机 Codex 和任意传入的 `cwd`。
3. 前端只保留 user/agent 的纯文本与图片，丢弃了命令、工具调用、diff、计划、审批、
   reasoning summary、文件变化、token/rate limit 等关键工作过程。

## 分析基线

- 仓库规模：`index.html`、`styles.css`、`script.js`、`server.js` 共约 2,000 行。
- 技术栈：Vanilla HTML/CSS/JavaScript + Node `http` 服务 + `codex app-server` stdio JSON-RPC。
- 本机验证：`codex-cli 0.134.0`；`/health` 正常；`/api/sync` 返回 23 个项目、80 个线程。
- 桌面验证：1280x720 三栏布局可用，项目与线程可搜索，真实线程可读取。
- 移动验证：390x844 时页面纵向堆叠为约 1,840px 长页面，缺少移动端页面级导航。
- Mac Codex 对照：OpenAI 2026-02-02、2026-04-16、2026-06-02 公布的桌面端能力，
  以及当前 app-server experimental schema。

## 当前已有功能

### 后端

- 启动并初始化本机 `codex app-server`。
- 获取未归档线程列表，按 `cwd` 聚合项目。
- 读取线程及其历史 turns。
- 在选定目录创建新线程。
- resume 线程并发送纯文本 turn。
- 收集最近 100 条 app-server 通知与 stderr。
- 提供静态文件、健康检查、同步、线程读取、新建线程、发送 turn、事件读取 API。

### 前端

- 项目列表、线程列表、项目搜索、线程搜索。
- 保持当前项目与线程选择，支持同步与重载线程。
- 展示 user/agent 纯文本消息及历史图片，支持图片放大。
- 新建线程、继续线程、`Cmd/Ctrl+Enter` 发送。
- 三个固定 prompt chip。
- 展示数据源、线程 ID、状态、消息数、后端地址和事件摘要。
- 1280px 三栏布局、1100px 隐藏 inspector、780px 以下纵向堆叠。
- 后端不可用时保留 mock/localStorage 降级数据。

## 与 Mac Codex 的主要差异

| 能力域 | 当前 Web | Mac Codex / 当前平台能力 |
| --- | --- | --- |
| 多任务 | 可浏览多个线程，但一个浏览器 UI 只发送一个当前 turn | 多 Agent 并行、长期任务监督、线程协调 |
| 工作隔离 | 直接使用传入 `cwd` | 内建 worktree、分支隔离、checkout 与合并工作流 |
| 运行过程 | 只展示纯文本回复和简化事件 | 命令、工具、文件改动、计划、来源、产物、进度实时呈现 |
| 审批 | 未实现，可能挂起 | 命令、文件修改、网络、权限、工具等原生审批 |
| 代码审查 | 无 diff 与评论 | 在线 review diff、批注、打开编辑器、处理 PR 评论 |
| 线程管理 | 新建、读取、发送 | rename、archive/unarchive、fork、compact、interrupt、steer 等 |
| Git | 无 | branch/worktree、stage、commit、push、PR 工作流 |
| Composer | 仅纯文本 | 文件/图片/上下文附件、mentions、slash commands、模型与模式选择 |
| 内容渲染 | `textContent` 纯文本 | Markdown、代码块、文件引用、终端输出、rich artifacts |
| 工作空间 | 假的“工作区/事件”按钮 | 多文件、多终端、预览器、summary pane、in-app browser |
| 扩展能力 | 无管理 UI | Skills、Plugins、Apps/Connectors、MCP、Computer Use、ImageGen |
| 自动化 | 无 | Automations、review queue、未来唤醒、复用线程、长期目标 |
| 个性化 | 无 | personality、memory、建议、配置与实验特性 |
| 远程能力 | 仅可手填后端 URL | SSH devbox、remote control、云任务与跨设备工作流 |
| 知识工作 | 无 artifact 工作区 | PDF、文档、表格、幻灯片、Sites、annotations |
| 移动端 | 三栏纵向堆叠 | 当前项目目标虽偏移动，但尚未形成适合手机的主从导航 |

## 关键实现问题

### P0 阻断与安全

- `server.js:64-71` 把所有带 `id` 的消息都当作已有请求响应，未处理 app-server 发来的
  server request，因此审批与 elicitation 无法响应。
- `server.js:234-273` 的 API 无认证、无授权、无 CSRF/Origin 校验、无速率限制。
- `server.js:251-261` 信任浏览器传入的 `cwd`，没有允许目录白名单或 realpath 边界检查。
- `server.js:392-398` 返回 `Access-Control-Allow-Origin: *`，与本机 Agent 控制 API 的风险不匹配。
- 请求体没有大小限制；错误响应可能向客户端暴露本机路径、登录态和内部错误。
- 没有 HTTPS、会话过期、审计日志、敏感字段脱敏或远程访问安全方案。

### P1 核心工作流

- `extractMessages` 只提取 `userMessage` 和 `agentMessage`，其余 turn item 全部丢弃。
- 回复不是逐 token/逐 item 流式展示；收到 agent message completed 后提前返回 partial。
- 没有 `turn/interrupt`，用户无法停止正在执行的任务。
- 没有审批 UI，无法批准或拒绝命令、文件、网络、权限、MCP 请求。
- 没有 diff、文件变化、命令输出、工具调用、计划和进度视图。
- 没有 thread archive/unarchive、fork、compact、rollback、rename、pin 或分页。
- 固定最多同步 80 条未归档线程，项目计数和历史并不完整。
- 同步会用空消息线程覆盖已加载线程；localStorage 会持久化敏感对话和事件。
- turn waiter 以 thread/turn 模糊匹配，多客户端并发时可能串线。

### P2 UI/UX 与移动端

- “工作区”和“事件”按钮没有事件处理，是不可用的装饰控件。
- 纯文本渲染导致 Markdown、代码块、链接、列表、表格和文件路径均不可交互。
- 事件面板以 stderr 为主，噪声大，缺少按 turn/item 分组、筛选、展开和严重级别。
- 1100px 以下直接隐藏 inspector；手机端把所有区域顺序堆叠，缺少 tab/drawer/back 导航。
- 390x844 实测首屏主要被项目/线程列表占用，发送区和运行状态需要长距离滚动。
- 缺少 loading skeleton、空状态引导、toast、重试、离线提示和稳定的运行中状态。
- 缺少深色模式、主题、字号密度、可调整栏宽、折叠栏和全屏工作区。
- 键盘可用性不完整：无命令面板、快捷键帮助、焦点管理、完整 focus-visible 样式。
- 图片 viewer 不是完整 dialog，缺少 focus trap、dialog 语义和下载/打开原图动作。

### P3 工程质量与产品化

- 无 `package.json`、依赖锁定、正式构建流程、测试框架、lint、format、CI。
- 无 API schema/类型生成，前后端依赖隐式对象结构。
- 无单元测试、协议测试、集成测试、E2E、视觉回归、可访问性测试、负载测试。
- 无结构化日志、metrics、trace、错误上报、健康详情和诊断导出。
- 无配置文件、环境校验、升级兼容策略、app-server capability negotiation。
- 无 PWA manifest、service worker、安装体验、通知、后台恢复或断线重连。
- README 仍把产品描述为最小 demo，缺少安全警告、架构、协议覆盖范围和故障排查。

## 完整 ToDo List

### P0：先做到可安全使用

- [ ] 实现 JSON-RPC server request 路由，区分 response、notification、server request。
- [ ] 支持命令执行、文件修改、额外权限、MCP elicitation、工具用户输入等审批响应。
- [ ] 为待审批请求建立队列、超时、取消、重复提交保护和审计记录。
- [ ] 默认只监听 loopback；非 loopback 启动必须显式开启安全模式。
- [ ] 增加登录会话或 capability token，并对所有 `/api/*` 做认证。
- [ ] 增加项目级授权与允许目录白名单，校验 `realpath(cwd)`。
- [ ] 禁止客户端为已有线程任意覆盖 `cwd`，以后端线程元数据为准。
- [ ] 移除宽泛 CORS，增加严格 Origin/Host 校验与 CSRF 防护。
- [ ] 增加请求体大小限制、速率限制、并发限制和输入 schema 校验。
- [ ] 增加安全响应头、敏感错误脱敏、日志脱敏和生产 HTTPS 指南。
- [ ] 增加子进程生命周期管理、崩溃恢复、优雅退出和 pending request 清理。
- [ ] 写安全测试：未认证访问、目录越界、恶意 cwd、跨域、超大 body、并发滥用。

### P1：补齐可用的 Agent 工作流

- [ ] 改为 SSE 或 WebSocket，把 notification/server request 实时推送到浏览器。
- [ ] 建立完整 turn/item 数据模型，保留 app-server 原始 item 类型和状态。
- [ ] 流式展示 agent message delta、reasoning summary、计划和执行进度。
- [ ] 展示 command execution、实时 stdout/stderr、退出码、耗时和终止操作。
- [ ] 展示 MCP/dynamic tool 调用、参数、进度、结果和错误。
- [ ] 展示 file change、unified diff、逐文件 diff、图片查看与生成结果。
- [ ] 实现审批卡片：批准一次、会话内批准、拒绝、取消、风险说明。
- [ ] 实现 `turn/interrupt`、turn steer/追加指令、失败重试和断线恢复。
- [ ] 支持 text、image、文件引用等完整 turn input。
- [ ] 支持 model、reasoning effort、service tier、approval policy、sandbox、collaboration mode 选择。
- [ ] 支持 thread rename、archive/unarchive、fork、compact、rollback、pin、删除本地视图。
- [ ] 支持 archived 视图、分页、无限滚动、准确项目计数和全局搜索。
- [ ] 支持 Git 状态、branch/worktree、diff review、stage、commit、push、PR。
- [ ] 支持打开文件、打开编辑器、复制路径、查看工作区文件树。
- [ ] 支持 goals、plan、sources、artifacts、token usage、rate limits 和 account 状态。
- [ ] 支持 skills、plugins、apps/connectors、MCP、hooks 的浏览、选择和管理入口。
- [ ] 支持 automations、review queue、未来唤醒、复用线程与通知。
- [ ] 支持 memory、personality、建议、配置与 experimental features。
- [ ] 支持 in-app browser、Computer Use、图片生成和 rich artifact 预览。
- [ ] 评估 SSH devbox、remote control、cloud task、Sites 与 annotations 的产品边界。

### P1：修复现有数据与并发问题

- [ ] 同步线程元数据时保留已加载 messages/items，不再用空数组覆盖。
- [ ] 把 localStorage 限制为无敏感 UI 偏好；线程内容使用内存或安全缓存。
- [ ] 为多浏览器标签页增加一致性策略和选中状态同步。
- [ ] 按 requestId/threadId/turnId/itemId 精确关联请求和通知。
- [ ] 支持同一线程并发保护、跨线程并行和浏览器刷新后的恢复。
- [ ] 避免在首个 agent message completed 时过早结束 HTTP turn。
- [ ] 为 app-server 断开、重启、模型刷新失败和登录过期提供恢复流程。
- [ ] 使用 app-server schema 生成 TypeScript 类型，并做 capability/version negotiation。

### P2：重做信息架构与 UI

- [ ] 桌面端改为可折叠/可调整宽度的项目栏、主工作区、summary/inspector。
- [ ] 将假“工作区/事件”按钮实现为真实 tab，或在完成前删除。
- [ ] 主消息流按 turn 展示 commentary、tool、approval、diff、final answer。
- [ ] 增加 Markdown、代码高亮、可复制代码块、表格、链接、文件引用和引用来源。
- [ ] 增加当前 turn 的 sticky progress、停止按钮、耗时和明确状态。
- [ ] 增加 summary pane：计划、改动文件、验证结果、来源、产物、风险。
- [ ] 事件视图改为结构化 timeline，支持筛选、搜索、展开原始 JSON 和导出。
- [ ] Composer 支持附件、拖放、粘贴图片、mentions、slash command、历史 prompt。
- [ ] 增加命令面板、快捷键帮助、最近项目、最近线程和收藏。
- [ ] 增加 loading、empty、error、offline、reconnecting、permission pending 等完整状态。
- [ ] 增加 dark mode、主题 token、字号/密度设置、栏位折叠和持久化。
- [ ] 移动端改为项目/线程/对话三层主从导航，支持 back、底部 tab 和 drawer。
- [ ] 移动端默认只展示对话，项目列表与 inspector 按需打开。
- [ ] 移动端保持 composer 固定可达，处理软键盘、安全区和横屏。
- [ ] 平板端用 drawer/overlay inspector，不能简单隐藏运行状态。
- [ ] 完成 WCAG 基线：语义、focus-visible、焦点管理、对比度、读屏标签、reduced motion。
- [ ] 将 image viewer 改为可访问 dialog，并支持原图、下载、复制和关闭焦点恢复。
- [ ] 增加 i18n，避免 UI、错误文本、日期格式和 prompt 全部硬编码中文。

### P2：产品与运营能力

- [ ] 明确产品定位：仅本机 companion、局域网移动端、还是可远程访问的 Web 产品。
- [ ] 若支持远程访问，设计设备配对、登录、会话撤销、权限范围与远程通知。
- [ ] 提供 onboarding：检测 Codex CLI、登录状态、版本、app-server 能力和目录授权。
- [ ] 提供设置页：后端、模型、sandbox、approval、通知、存储、隐私与实验功能。
- [ ] 提供账户、额度、rate limit、版本更新和诊断页。
- [ ] 提供通知中心和任务完成/审批等待的系统或 Web Push 通知。
- [ ] 定义数据保留、敏感信息、遥测、隐私和企业策略。

### P3：工程化、测试与文档

- [ ] 引入模块化前端与后端结构；避免继续扩展单个 `script.js`/`server.js`。
- [ ] 增加 `package.json`、固定 Node 版本、依赖锁、lint、format、typecheck、build。
- [ ] 抽离 app-server client、API router、auth、state store、renderers 和 domain models。
- [ ] 增加统一错误类型、重试策略、取消信号和超时策略。
- [ ] 增加单元测试：normalize、extract、event reducer、state reducer、权限校验。
- [ ] 增加协议契约测试：所有使用的方法、通知和 server request。
- [ ] 增加集成测试：真实/模拟 app-server、重连、审批、并发 turn、部分失败。
- [ ] 增加 E2E：同步、读取、新建、发送、停止、审批、diff、归档、移动导航。
- [ ] 增加桌面/平板/手机视觉回归与可访问性自动测试。
- [ ] 增加安全、负载、长线程、80+ 项目、数千线程和大输出测试。
- [ ] 增加 CI，并把 `node --check`、测试、lint、类型检查和 E2E 设为合并门禁。
- [ ] 增加结构化日志、metrics、trace、错误上报、健康详情和诊断包导出。
- [ ] 更新 README：架构图、启动方式、安全边界、协议覆盖、配置、测试、故障排查。
- [ ] 增加版本兼容矩阵、升级策略、changelog、release 与回滚流程。

## 建议实施顺序

1. P0 安全边界与 server request/审批闭环。
2. 实时传输和完整 turn/item 数据模型。
3. 命令、工具、diff、审批、停止任务等核心工作台 UI。
4. 线程/Git/worktree/summary pane 与移动端导航。
5. Skills、Plugins、Automations、Browser、Artifacts 等扩展能力。
6. 工程化、测试、可观测性、远程访问与产品化。

## 官方对照资料

- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/)
- [Codex for every role, tool, and workflow](https://openai.com/index/codex-for-every-role-tool-workflow/)
