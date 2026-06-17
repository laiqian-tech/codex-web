# 设计：在 Codex Web 平台上接入 Claude Code 引擎（双引擎统一 UI）

> 日期：2026-06-16　状态：已批准方向，落地实施中

## 目标

让现有 Codex Web（手机网页客户端）支持第二个引擎 **Claude Code**，与 Codex 并存于同一套 UI。

经澄清确定的范围：
- **双引擎统一 UI**：同一界面里每个对话可属于 Codex 或 Claude。
- **可中途切换引擎**：对话可从 Codex 切到 Claude（反之亦然），切换时把已有记录重放为新引擎的初始上下文。
- **只管新建**：不解析 `~/.claude/projects/` 的历史会话；只列出/续接 web 自己创建的 Claude 对话。
- **预设权限自动放行**：Claude 以固定权限模式运行（`acceptEdits` + 默认工具），初期不接交互式审批。

## 进程模型（方案 B：per-turn `--resume`）

每个 turn = 一次性 spawn：

```
claude -p "<prompt>" \
  --output-format stream-json --verbose --include-partial-messages \
  --permission-mode acceptEdits \
  [--resume <sessionId>]        # 首轮不带，从 init 事件捕获 sessionId
  [--model <model>]
  （cwd 设为对话所属项目目录）
```

跑完即退。流式回复经现有 SSE 通道转发。中断 = kill 进程。

理由：与项目现有"零依赖 + shell out 到 codex"风格一致；生命周期最简单，无进程池；与 web 现有 turn/SSE 流程严丝合缝。

## stream-json 事件 → 内部消息归一化

已实测的事件类型与映射（在 `claude-engine.js` 内解析）：

| Claude 事件 | 处理 |
|---|---|
| `system/init` | 捕获 `session_id`（存为对话 nativeId）、model、permissionMode |
| `assistant` + content `text` | agent 文本；`--include-partial-messages` 下 `stream_event` 增量 → SSE delta |
| `assistant` + content `tool_use` | 归一化为 `{kind:"command"\|"tool"\|"fileChange"}`（按工具名映射 Bash/Edit/Write 等） |
| `user` + `tool_result` | 附到对应工具事件的输出 |
| `result` | 最终回复文本（`result` 字段）+ usage/cost；turn 结束 |
| `rate_limit_event` | 可选喂"用量"卡片 |

归一化后的结构与 `transcript.js` 产出的内部消息一致（`{role:"agent",text}` / `{kind,...}`），**前端渲染逻辑零改动**。

## 数据模型：逻辑对话 ≠ 原生会话

为支持中途切换，引入逻辑对话层（server 内存 + `claude-threads.json` 持久化）：

```
Conversation:
  id          web 稳定 id
  engine      "codex" | "claude"
  nativeId    codex threadId | claude sessionId（首轮后写入）
  cwd, title, updatedAt
  messages[]  归一化消息（用于切换引擎时重放 + 列表预览）
```

- Codex 对话：沿用现有 `thread/list` 同步，`engine="codex"`，不落 claude-threads.json。
- Claude 对话：web 创建时分配 id，首轮捕获 sessionId 回填 nativeId，整条存 claude-threads.json。
- `/api/sync` 把 codex 线程与本地 claude 对话**合并**返回，各带 `engine` 字段。

## 引擎适配器接口

```
EngineAdapter:
  startConversation(cwd, settings)                         → { id/nativeId }
  runTurn(nativeId, text, cwd, settings, images, onEvent)  → { reply, sessionId, partial }
  interrupt(nativeId)
  // codex 独有 fork/rollback/review/compact/skills/mcp；claude 不支持的返回 415/不可用
```

HTTP 层按对话 `engine` 分发到对应 adapter。`CodexAppServer` 即 codex adapter（基本不动）；`ClaudeEngine` 新增。

## 切换引擎（context replay）

`POST /api/threads/:id/switch-engine { to: "claude"|"codex" }`：
1. 取该对话归一化 messages，拼成一段文本上下文（"以下是此前对话记录……请在此基础上继续"）。
2. 在目标引擎上新建会话，把这段文本作为首轮 prompt 发送（工具调用/diff 无法迁移，只迁文本——已知有损）。
3. 更新对话 `engine` + `nativeId`，保留 messages。

## 错误处理

- `claude` 未安装 / 非 0 退出：turn 返回错误文案（复用 `formatSendError` 思路），事件流记 `claude.failed`。
- stream-json 行解析失败：跳过该行，不中断整流。
- 登录态失效（claude）：提示在终端 `claude` 登录。
- 切换引擎时目标引擎不可用：保持原引擎不变并报错。

## 测试

- `test/claude-engine.test.js`：喂样本 stream-json 行，断言归一化输出（agent 文本 / 工具事件 / 最终 reply / sessionId 捕获）——**不真调 claude**，纯解析单测。
- `npm test` / `npm run check` 全过。
- 运行 app 真发一轮 Claude 对话，确认流式回复 + 角标 + 切换引擎。

## 非目标（本期不做）

- 不解析历史 Claude 会话；不接 Claude 交互式权限审批；不做 Claude 的 fork/rollback/review/compact（这些 codex 特有能力在 Claude 对话下入口置灰）。
