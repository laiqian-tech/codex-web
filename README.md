# Codex Web

一个手机优先的网页客户端，让你从浏览器（或装成 PWA）远程驱动本机的 **Codex** 和 **Claude Code** 两个编码引擎——在同一套界面里新建对话、续接线程、看流式回复与事件、审批命令、切换模型。

后端是一个零依赖的 Node 代理：浏览器只与它通信，由它在本机 stdio 上拉起 `codex app-server` 和 `claude` CLI。手机端不直接访问任何引擎进程。

```
浏览器 / PWA ──HTTP+SSE──> server.js ──┬── codex app-server (常驻 JSON-RPC)
                                        └── claude -p --resume (按轮 spawn)
                                              ↓
                                   ~/.codex · ~/.claude（各自落盘）
```

## 功能

- **双引擎统一 UI**：每个对话可属于 Codex 或 Claude，列表里以角标区分（深色 `C` / 橙色 `✶`）。
- **中途切换引擎**：把已有对话记录作为上下文重放，在另一引擎上接着聊（文本迁移，工具调用/diff 不迁移）。
- **流式回复**：经 SSE 实时显示增量文本、工具调用、命令执行、文件改动、推理过程。
- **引擎感知的模型切换**：Codex 对话列 `/api/models` 返回的模型；Claude 对话列 Opus/Sonnet/Haiku 别名；选择按引擎分别记忆。
- **线程操作**：新建、续接、重命名、归档、压缩、Fork、回滚、Review、Git Diff、技能/MCP/插件查看（Codex 专有项在 Claude 对话下自动隐藏）。
- **命令/文件审批**：Codex 暂停请求权限时弹出"允许/本会话允许/拒绝/中断"对话框。
- **移动端打磨**：左右 off-canvas 抽屉、吸底输入、安全区适配、键盘跟随、下拉刷新、长按动作面板、暗色跟随系统、可安装 PWA。
- **附加输入**：图片粘贴/选择、`@` 文件名补全、语音输入（Web Speech）、朗读回复（TTS）。

## 运行

需要本机已安装并登录 [Codex CLI](https://github.com/openai/codex)（`codex login`）和/或 [Claude Code CLI](https://docs.claude.com/claude-code)（`claude`）。

```bash
node server.js
```

打开 <http://127.0.0.1:5173/>。

`server.js` 通过 stdio 启动 `codex app-server`，并按需 spawn `claude`，对外提供 `/api/sync`、`/api/threads`、`/api/stream` 等接口给前端。浏览器不直接访问任一引擎。

### 局域网 / 手机访问

默认只绑 `127.0.0.1`。让手机经局域网访问：

```bash
HOST=0.0.0.0 node server.js
```

> ⚠️ 当前版本**无令牌鉴权**。绑定 `0.0.0.0` 后同一网络内任意设备都能读取项目并执行任务（Claude 默认以 `acceptEdits` 权限模式自动放行工具）。请仅在可信局域网使用，不要把端口暴露到公网。

环境变量：`HOST`、`PORT`（默认 5173）、`ALLOW_ORIGIN`（CORS，默认 `*`）。

## 架构

| 关注点 | Codex | Claude Code |
|--------|-------|-------------|
| 后端入口 | `codex app-server`（常驻 JSON-RPC over stdio） | `claude -p --output-format stream-json`（按轮 spawn） |
| 续接 | `thread/resume` | `--resume <sessionId>`（首轮从 init 事件捕获 id） |
| 落盘 | `~/.codex/sessions/*.jsonl` | `~/.claude/projects/.../*.jsonl` |
| 适配器 | `CodexAppServer`（server.js 内） | `ClaudeEngine`（`claude-engine.js`） |

两个引擎都把原生事件归一化成同一套内部消息结构，所以前端渲染逻辑零差异。设计细节见 [docs/superpowers/specs/2026-06-16-claude-engine-design.md](docs/superpowers/specs/2026-06-16-claude-engine-design.md)。

### 文件一览

| 文件 | 职责 |
|------|------|
| `server.js` | HTTP 代理、引擎注册表与路由分发、Codex app-server 客户端、SSE、审批、Claude 对话持久化 |
| `claude-engine.js` | Claude 引擎适配器：spawn `claude`、解析 stream-json、归一化 |
| `protocol.js` | JSON-RPC 消息分类、审批摘要、设置/图片清洗 |
| `transcript.js` | Codex thread item → 可渲染消息的映射 |
| `markdown.js` | 轻量 Markdown 渲染 |
| `index.html` / `styles.css` / `script.js` | 前端单页 |
| `sw.js` / `manifest.webmanifest` | PWA 离线壳与安装清单 |
| `scripts/` | `gen-icons.mjs`（生成 PWA 图标）、`mobile-check.mjs`（移动视口回归） |

更多分析与设计文档见 [`docs/`](docs/)。

## 测试

```bash
npm test          # 协议路由 / 审批 / 归一化 / Claude 解析 单测 + 集成（node --test）
npm run check     # node --check 语法校验（含 claude-engine.js）
npm run test:mobile  # Playwright 移动视口回归（360/390/412/横屏）
```

`npm run test:mobile` 需要先启动 `node server.js`，并安装 Playwright + Chromium。

## 已知边界

- 不解析历史 Claude 会话；web 只列出/续接自己创建的 Claude 对话。
- Claude 暂不支持 Fork/回滚/Review/压缩/图片输入与交互式权限审批（以 `acceptEdits` 自动放行）。
- 切换引擎为"带上下文新建"，历史以文本重放，工具调用与 diff 不迁移。
- 同一对话不要在 Mac app 与 web 端同时各跑一轮（两个进程会并发追加同一 rollout 文件）。
