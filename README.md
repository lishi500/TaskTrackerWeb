# TaskTrackerWeb

这是可 clone 的**单游戏任务中枢模板**。每个游戏使用自己的 `<Game>-Tracker` 实例；实例内的 `tracker/task_tracker.csv` 是唯一的当前任务状态来源，网页与 Agent Run 不保留第二份任务状态数据库。

模板代码与实例状态严格分离：

- 将通用功能先合并、验证并提交到本模板；
- 再把模板的代码、文档、Skill 与测试同步到各实例；
- 不覆盖实例的 `tracker/`、`task-hub.config.json` 或实例特有的 `.agents/` 链接/配置。

## 新建和启动实例

```bash
node scripts/init-instance.mjs --project-id my-game --project-name "My Game"
node scripts/start.mjs
```

启动脚本默认只监听 loopback 并选择可用端口。需要稳定 URL 时可用 `PORT=4300 node scripts/start.mjs`；`TRACKER_CSV` 仅用于迁移或隔离测试，不能把一套实例伪装成多项目 Tracker。

让游戏仓库内的 Agent 使用此实例的当前 Skill：

```bash
node scripts/link-game-skill.mjs /absolute/path/to/game-repository
```

## 状态、Run 与审查

Agent 先读取 `GET /api/tasks/<TaskID>/packet`。packet 给出任务、依赖/反向依赖、既有 Run 与当前 `trackerRevision`；所有写操作必须使用这个 revision、`Content-Type: application/json` 与同源 `Origin`。

普通实现只可从 `Ready` 使用 `POST /api/runs/start` 领取。Hub 分配单调的 `TaskID-R0001`，使任务进入 `In Progress`，并在 `tracker/task-records/<TaskID>/<RunID>/` 保存 Run、事件与不可覆盖的文本 artifact。Run 关闭具有固定边界：

- `verified` → `In Review`，绝不自动 `Done`；
- `blocked` → `Blocked`，必须写明 blocker；
- `incomplete` → 保持 `In Progress`，并记录缺失证据；
- `awaiting-human` → 调用者必须显式提供 `ownerStatus: "Awaiting Owner"` 或 `"Awaiting Owner Gate"`；模板不会根据 Task ID 猜测项目流程。

Run claim/close 均保存可恢复 intent；预提交中断会留下不可复用的 `Abandoned` Run，CSV 已提交但 Run 未收尾时会在后续操作前恢复。文本 artifact 每份最多 128 KB、每 Run 最多 32 份/512 KB；可用安全相对路径如 `logs/editor.log`、`test-results.xml`、`evidence.md`。二进制、大型构建产物或截图应在 evidence 中记录仓库相对路径或 HTTPS 引用。

独立审查使用 `POST /api/tasks/<TaskID>/review`：reviewer 先 `action: "claim"`，再提交 `action: "decision"` 及 `approved`、`rejected` 或 `blocked`。reviewer 必须不同于 `Implementer`；批准才会进入 `Done`，可修复的拒绝回到 `Ready`，阻断审查需要具体 blocker。这个 API 不解释 owner 文字，也不解锁下游。

对于未领取的 `Ready` packet，Agent 可用 `POST /api/tasks/<TaskID>/block` 记录发现的矛盾或缺失条件，不创建 Run。通用 `POST /api/tasks/<TaskID>/unblock` 仅验证没有活跃 Run、所有直接依赖均为 `Done`、并记录理由；已经结束的 blocked Run 保留的历史 `Implementer` 不视为活跃 claim，成功解锁时会清空该陈旧字段。它不理解任何游戏特有的 Gate、Release 或产品决策规则。调用方必须先按该游戏自己的流程确认该状态转换被允许。

Owner 反馈仍只作为原始 Evidence 写入，并转为 `Awaiting Agent Evaluation`；它不会自动完成任务、批准 Gate、评审实现或解锁依赖。

首页在“当前 Agent 工作”和 Milestone 视图之间提供“可领取的 Session”面板。它只列出 CSV 状态为 `Ready` 的任务，方便协调者确认下一项可被 Agent 领取的工作；点击任务可查看依赖、验收与证据。面板不替代领取 API：真正领取时仍由 Hub 使用最新 revision 再次验证 `Ready` 状态和全部直接依赖。

## 验证

```bash
node --check server.mjs
node --check public/app.js
node scripts/test-managed-runs.mjs
```

最后一项在临时 CSV 中验证 Ready-only claim、revision/origin/MIME 拒绝、嵌套 artifact 与不可覆盖、claim/close 中断恢复、独立 review、pre-claim block、以及 generic dependency-unblock；不会写当前实例的 Tracker。
