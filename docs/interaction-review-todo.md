# Codex Web — 交互必要性 & 易用性审查（真人视角）

> 日期：2026-06-18　方法：清点全部交互元素，逐个问"普通人会用吗 / 是否多余 / 是否清晰"。

## 结论
功能已很全，但**面向开发者的噪音 + 生僻图标**拉高了普通用户的认知成本。本轮做减法和澄清，不删真正有用的能力（power-user 旋钮改为折叠/收纳，而非删除）。

## ToDo（按优先级）

### P0 · 删掉纯噪音（零功能损失）
- [x] 1. 删除假 Mac 红绿灯 `window-dots` ✅ 连带清掉为它让位的 margin-top。
- [x] 2. 删除死元素 `viewChatBtn ▣` ✅ DOM/监听/CSS 全清，实测 DOM 中已不存在。

### P1 · 顶栏去生僻图标
- [x] 3. 桌面顶栏不再常驻 ✎⤡🗄 ✅ 全视口收进 ⋯ 菜单（实测三个 standalone display:none，菜单含重命名/压缩/归档）。
- [x] 4. `☷` → `⚙` ✅ 桌面+手机实测图标为 ⚙，aria/title 改"运行与设置面板"。

### P1 · 运行面板去开发者黑话
- [x] 5. 连接状态人话 ✅ "已连接 / Mock"（不再裸 `codex-app-server`）。
- [x] 6. 线程 UUID → 引擎 ✅ 单元格标签"引擎"、值 Codex/Claude，完整 ID 仅 hover title。
- [x] 7. 后端地址+检查连接 ✅ 收进 `<details class="advanced">高级</details>`，默认收起（实测 open=false）。

### P2 · 输入区语义澄清
- [x] 8. chips 区分 ✅ 提示词 chips 与工具 chips 间加竖分隔线，工具 chips 改虚线/透明样式（实测 4 个 .tool）。

### 验证
- [x] 9. 回归 ✅ `npm test` 79/79、`npm run check`、`npm run test:mobile` 全过；桌面+手机浏览器复测零 JS 错误、菜单各动作仍可达。
