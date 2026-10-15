# TaskTrackerWeb

这是可 clone 的**单游戏任务中枢模板**。每个游戏使用自己的 `<Game>-Tracker` 实例；实例内的 `tracker/task_tracker.csv` 是唯一的当前任务状态来源，网页与 Agent Run 不保留第二份任务状态数据库。

模板代码与实例状态严格分离：

- 将通用功能先合并、验证并提交到本模板；
- 再把模板的代码、文档、Skill 与测试同步到各实例；
- 不覆盖实例的 `tracker/`、`task-hub.config.json` 或实例特有的 `.agents/` 链接/配置；实例中的任务、Run、证据和项目规则绝不回流到模板。

模板网页不包含任何特定游戏名称或品牌。实例启动时，网页只从自身 `task-hub.config.json` 的 `instance.projectName`/`projectId` 读取显示名称；不要把项目名、TaskID 前缀、玩法规则或实例端口写回模板。

## 依赖图审计与死锁防护

Hub 将 `DependsOn` 视为一个必须无环的任务图，而不是只在 UI 中展示的文本。每一次 Hub 写入都会先读取并校验当前 CSV，原子替换前还会校验拟写入的完整图；因此现有状态操作，以及未来的新增、删除或修改依赖操作，都不能把未知 TaskID、自依赖、重复依赖、重复 TaskID、依赖环、无效 `TaskType` 或不合法 Story 结构写回 source of truth。校验失败时该操作返回 `422`，CSV 保持不变。

对于通过编辑器或脚本在 Hub 外修改 CSV 的情况，使用只读审计接口：

```bash
curl http://127.0.0.1:4173/api/dependency-audit
```

它始终返回 `200` 和结构化报告，即使 CSV 已不合法；`valid: false` 时检查 `csvErrors`（包括 `task-type`、`story-structure`、`story-parent`、`story-dependency`）、`unknownDependencies`、`selfDependencies`、`duplicateTaskIds`、`duplicateDependencies` 与 `cycles`。每个环会以稳定的 TaskID 路径表示，例如 `TASK-001 -> TASK-002 -> TASK-003 -> TASK-001`。普通 API 读取和所有写入则拒绝这类 CSV，并在 `422` 响应中附同一份 `dependencyAudit`，防止图错误演变为无提示的等待死锁。

CSV 仍应只由 Hub 写入。外部批量迁移或人工维护不可避免时，在开始服务操作前、以及新增/删除任务或修改 `DependsOn` 后各执行一次审计；先修复报告的问题，再继续工作流。

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

## 升级既有实例

模板先完成并验证通用改动后，先对既有实例做无写入检查，再由明确的 `--apply` 同步。同步器只处理声明的模板代码、网页、文档、Skill、测试和 skeleton；它绝不写入 `tracker/` 或 `task-hub.config.json`，遇到目标 symlink 会拒绝操作。

```bash
node scripts/sync-template.mjs --target /absolute/path/to/existing-game-tracker
node scripts/sync-template.mjs --target /absolute/path/to/existing-game-tracker --apply
```

同步后在实例仓库运行其测试，并按需要重启本地服务。实例的 Git 提交策略、任务状态和证据仍由该实例单独管理；不要把它们合入模板仓库。

## 工作项类型与层级

标准 CSV 现为 19 列，`TaskID` 后增加必填 `TaskType`：`Task`、`Bug` 或 `Story`。`Task` 和 `Bug` 都是可执行工作项；`Bug` 仅用于明确标记缺陷，不会绕开正常的依赖、Run 与独立审查流程。

`Story` 是远期或较大功能的不可执行范围容器：必须没有 `ParentID`、`DependsOn`，且 `ReviewRequired=No`；它不能被 admit、claim、Run、review 或作为依赖。新建的 `Task`/`Bug` 的 `ParentID` 只能指向一个 Story，且不能依赖 Story。这样可以先记录目标，再在接近执行时拆出可验证子项，避免为远期功能过早制造细碎任务。旧 CSV 在迁移前以 `Task` 读取；对既有实例，先用当前 revision 调用 `POST /api/tracker/task-types/migrate`，它会显式写入 `TaskType=Task` 和迁移 Evidence，不会猜测旧 `ParentID` 的含义：原值会清空并追加至 Evidence 作为历史记录。

`Milestone` 继续是交付窗口/分组，而不是 `TaskType`：它不拥有 claim、Run、依赖或 review 语义，因此不会和 Story 的范围层级重复。

## 状态、Run 与审查

Agent 先读取 `GET /api/tasks/<TaskID>/packet`。packet 给出任务、依赖/反向依赖、既有 Run 与当前 `trackerRevision`；所有任务写操作必须使用这个 revision、`Content-Type: application/json` 与同源 `Origin`。

这里的 revision 要求适用于任务写入；工具链事件使用独立的并发契约，见下文。任务包的 `packet.context.story` 带入已解析的父 Story 目标、Acceptance、SpecRef 与 Milestone；读取 Story 时，`context.children` 给出直接 Task/Bug 子项。它们均由同一 CSV 派生，不增加可写状态，也不将 Story 变成执行依赖。将切片的行为契约放进 SpecRef，并设置明确的集成验收 Task；子项 Done 的数量不能代替整体玩家路径验收。

普通实现只可从 `Ready` 的 `Task`/`Bug` 使用 `POST /api/runs/start` 领取。默认实例启用 `workflow.serialLane`：Hub 同时只允许一个 Agent task 处于 `Ready`、`In Progress` 或 `In Review`；Run 开始时，只会把唯一的直接后继从 `Backlog` 自动 arm 为 `Blocked`。更远的链路保持 `Backlog`。Hub 分配单调的 `TaskID-R0001`，使任务进入 `In Progress`，并在 `tracker/task-records/<TaskID>/<RunID>/` 保存 Run、事件与不可覆盖的文本 artifact。Run 关闭具有固定边界：

- `verified` → `In Review`，绝不自动 `Done`；
- `blocked` → `Blocked`，必须写明 blocker；
- `incomplete` → 保持 `In Progress`，并记录缺失证据；
- `awaiting-human` → 调用者必须显式提供 `ownerStatus: "Awaiting Owner"` 或 `"Awaiting Owner Gate"`；模板不会根据 Task ID 猜测项目流程。

Run claim/close 均保存可恢复 intent；预提交中断会留下不可复用的 `Abandoned` Run，CSV 已提交但 Run 未收尾时会在后续操作前恢复。文本 artifact 每份最多 128 KB、每 Run 最多 32 份/512 KB；可用安全相对路径如 `logs/editor.log`、`test-results.xml`、`evidence.md`。二进制、大型构建产物或截图应在 evidence 中记录仓库相对路径或 HTTPS 引用。

独立审查使用 `POST /api/tasks/<TaskID>/review`：reviewer 先 `action: "claim"`，再提交 `action: "decision"` 及 `approved`、`rejected` 或 `blocked`。reviewer 必须不同于 `Implementer`；批准才会进入 `Done`，可修复的拒绝回到 `Ready`，阻断审查需要具体 blocker。在 serial lane 中，批准只自动推进唯一且依赖齐全的直接后继；多个候选保持 `Backlog`，由协调者通过 Service 显式选择，不会批量解锁。

状态语义分开使用：`Blocked` 表示已经纳入近期执行链、但有具体可行动的前置/环境/规则阻碍；`Backlog` 表示已规划但尚未纳入近期执行链的工作，不能出现在 blocker 监控里，也不能领取。不要把“未来 Milestone 尚未开放”写成 `Blocked`。

对于未领取的 `Ready` packet，Agent 可用 `POST /api/tasks/<TaskID>/block` 记录发现的矛盾或缺失条件，不创建 Run。通用 `POST /api/tasks/<TaskID>/unblock` 仅验证没有活跃 Run、所有直接依赖均为 `Done`、并记录理由；已经结束的 blocked Run 保留的历史 `Implementer` 不视为活跃 claim，成功解锁时会清空该陈旧字段。`POST /api/tasks/<TaskID>/park` 可把无 claim/active Run 的 `Blocked` 任务收回 `Backlog`；`POST /api/tasks/<TaskID>/admit` 由协调者把 `Backlog` 任务重新纳入近期链并显式设为 `Ready`（全部依赖已 Done 且 lane 空闲）或 `Blocked`（仅当唯一直接前置正在进行/Review，其他依赖 Done）。这些 API 不理解任何游戏特有的 Gate、Release 或产品决策规则。调用方必须先按该游戏自己的流程确认该状态转换被允许。

如果发现任务的 `Task`、`SpecRef` 或 `Acceptance` 与冻结架构相互矛盾，协调 Agent 不得只在 Evidence 中重新解释旧要求，也不得直接编辑 CSV。可在任务没有活跃 Run 或 review claim，且状态为 `Backlog`、`Ready` 或 `Blocked` 时，使用 `POST /api/tasks/<TaskID>/contract` 提交完整替换后的三项字段、当前 revision、Agent 和具体修订理由。Hub 保留旧 Evidence，并追加字段清单、UTC 与理由；它不会改变状态、依赖、OwnerRole、优先级或审查历史。已 `In Progress`/`In Review`/`Done` 的任务必须通过新的补救任务处理，不可回写其完成时的契约。

如果新发现的前置条件必须进入既有、未启动任务的依赖图，使用 `POST /api/tasks/<TaskID>/dependencies`，提交当前 revision、Agent、具体理由和完整替换的分号分隔 `dependsOn`。该接口只接受没有活跃 Run 或 review claim 的 `Backlog` 或 `Blocked` 任务，拒绝已 `Ready`、活跃、审查中或完成的任务；已关闭 blocked Run 保留的历史 `Implementer` 不属于活跃 claim，不能阻止这类可审计修订。接口原子校验未知 ID、自依赖、重复依赖和环，并保留旧依赖与新依赖的 Evidence。不要通过直接编辑 CSV 规避该保护。

已完成/审查中的任务发现独立缺陷时，协调 Agent 必须创建新的补救任务，不能回写旧任务。使用 `POST /api/tasks` 携带当前 `trackerRevision`、命名 Agent、创建理由，以及完整 `newTask`（`taskId`、必填 `taskType`、`milestone`、`workstream`、`task`、`specRef`、`dependsOn`、`ownerRole`、`priority`、`acceptance`、`reviewRequired`，可选 `parentId`）。Hub 只创建 `Backlog`：它会原子校验完整依赖图、拒绝重复 ID/未知依赖/环，并写入 `CREATED` Evidence。随后仍必须按项目 Gate 和普通 `/admit` 流程纳入近期执行链；创建接口不能伪造 `Ready`、执行者、审查或完成状态。

Owner 反馈仍只作为原始 Evidence 写入，并转为 `Awaiting Agent Evaluation`；它不会自动完成任务、批准 Gate、评审实现或解锁依赖。协调 Agent 核验原文后，只能使用 `POST /api/tasks/<TaskID>/owner-evaluation` 记录 `approved`、`blocked`、`deferred` 或 `return-to-owner`；只有 `ReviewRequired=No` 的 owner task 可用该 API 完成。

首页“需要你处理”只计入 `Awaiting Owner` / `Awaiting Owner Gate`；反馈后的 `Awaiting Agent Evaluation` 进入“当前 Agent 工作”，任务详情仍允许补充反馈。自动排队且前置仍活跃的 Blocked 项单列为“正常依赖等待”，不混进“需处理的阻塞”；自定义或未知 blocker 保守地保留在需处理列表。此展示不更改 CSV 状态。历史 ARMED 文本不能覆盖后来新增的独立 blocker，自动推进/撤销也遵循这一边界。

当前执行责任仍借助 `ReviewRequired` 约定区分：Yes 为需独立审查的 Agent 工作，No 用于 owner 流程。新增 TaskType 没有解除这个耦合；不要把普通 Agent Task/Bug 改为 No 来实现自检免审。轻量化先通过合理的任务粒度和按风险选验证实现。

当一个已受管的协调 Run 需要在协调任务完成前，将其直接依赖的一项、未领取的非 review `Backlog` 工作暴露给 owner 时，使用 `POST /api/tasks/<TaskID>/owner-wait`。调用必须明确给出 `ownerStatus`（`Awaiting Owner` 或 `Awaiting Owner Gate`）、具体理由、活跃的 `authorityTaskId` 与相同的认领 Agent 身份。Hub 会核验 authority task 是该目标的直接依赖，且该 Agent 拥有其活跃 Run；不会从 Task ID 或 Milestone 推断语义。这让 Human/owner 准备可审计地进入等待，且不会手改 CSV 或提前把协调任务标为 Done。

首页在“当前 Agent 工作”和 Milestone 视图之间提供“可领取的 Session”面板。它只列出 CSV 状态为 `Ready` 的 `Task`/`Bug`，方便协调者确认下一项可被 Agent 领取的工作；点击任务可查看依赖、验收与证据。面板不替代领取 API：真正领取时仍由 Hub 使用最新 revision 再次验证 `Ready` 状态和全部直接依赖。

## 工具链问题看板

`tracker/toolchain_issue_events.jsonl` 是跨任务工具链健康事件的追加式权威，不是第二套任务状态。Agent 在某一 Task/Run 上遇到可复现的工具链故障时，调用 `POST /api/toolchain-issues`，至少提供 `{ taskId, runId?, failureKey, reporter, toolchain, operation, summary }`；`failureKey` 必须是稳定小写标识符，例如 `unity.cli.editor-play-timeout`，不能用含时间戳、绝对路径或原始错误全文的字符串。

看板按 `failureKey` 聚合多个任务的报告。Owner 使用 `POST /api/toolchain-issues/<failureKey>/ack` 提交 `{ acknowledger, notes, expectedReportCount }`，其中 `expectedReportCount` 必须是刚查看的该问题 `totalReportCount`。缺少/非法计数返回 400；期间有新报告则返回 409 且不写 ACK，需刷新并查看新报告后再确认。旧 ACK 调用方必须补充此字段；报告接口不变。ACK 是确认/处理动作，不等于已经修复，也不改变任务状态或解除 blocker。

ACK 后问题从默认看板隐藏但历史不删除；同一 key 重现时显示 `1 (5)`，分别表示 1 个新报告和此前已 ACK 的 5 个报告。使用页面“包含已 ACK 的历史”或 `GET /api/toolchain-issues?includeAcknowledged=true` 可审计历史聚合项。报警源读取失败会明确显示不可用，任务看板仍可加载；不可用不显示为零报警。一次命令的轮询不是多次故障报告，告警计数也不是独立根因数。

## 验证

```bash
node --check server.mjs
node --check public/app.js
node scripts/test-managed-runs.mjs
node scripts/test-serial-lane.mjs
node scripts/test-dependency-audit.mjs
node scripts/test-task-types-and-toolchain-issues.mjs
node scripts/test-delivery-context.mjs
node scripts/test-template-sync.mjs
```

所有测试均使用临时 CSV，不会写当前实例的 Tracker；类型/工具链测试验证旧 schema 显式迁移、Story 执行防护/上下文、跨任务告警聚合、过期 ACK 拒绝与重现计数。交付上下文测试覆盖 Owner/Agent 交接、补充反馈、正常依赖等待与历史标记不覆盖新 blocker。
