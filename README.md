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
curl "$(cat tracker/.tracker-url)/api/dependency-audit"   # PowerShell: curl.exe (Get-Content tracker\.tracker-url)/api/dependency-audit
```

它始终返回 `200` 和结构化报告，即使 CSV 已不合法；`valid: false` 时检查 `csvErrors`（包括 `task-type`、`story-structure`、`story-parent`、`story-dependency`）、`unknownDependencies`、`selfDependencies`、`duplicateTaskIds`、`duplicateDependencies` 与 `cycles`。每个环会以稳定的 TaskID 路径表示，例如 `TASK-001 -> TASK-002 -> TASK-003 -> TASK-001`。普通 API 读取和所有写入则拒绝这类 CSV，并在 `422` 响应中附同一份 `dependencyAudit`，防止图错误演变为无提示的等待死锁。

CSV 仍应只由 Hub 写入。外部批量迁移或人工维护不可避免时，在开始服务操作前、以及新增/删除任务或修改 `DependsOn` 后各执行一次审计；先修复报告的问题，再继续工作流。

## 新建和启动实例

```bash
node scripts/init-instance.mjs --project-id my-game --project-name "My Game" --empty --port 4321
node scripts/start.mjs --detach      # 后台启动，只打印 URL；之后任何 tt 命令也会自动启动服务
```

- `--empty` 只写 CSV 表头（不带示例行）；省略时会复制 skeleton 示例行，真实使用前需替换。`--port` 省略时由 `project-id` 在 4300–4999 内稳定推导（该端口当下被占用则顺延到下一个空闲端口），并写入 `task-hub.config.json` 的 `instance.port`。
- **端口固定**：优先级为环境变量 `PORT` > `instance.port` > 由 `projectId` 推导的稳定端口，所以同一项目每次启动 URL 都不变（不再随机）。`TRACKER_CSV` 仅用于迁移或隔离测试，不能把一套实例伪装成多项目 Tracker。
- **URL 发现**：服务监听成功后自己写入 `tracker/.tracker-url`（URL）和 `tracker/.tracker-pid`，正常退出时删除；被强杀留下的旧文件会在下次启动时被覆盖。无论用 `start.mjs`、`node server.mjs` 还是别的方式启动都一样。`start.mjs` 的第一行输出就是 URL；`--detach` 在后台运行（日志在 `tracker/server.log`）并在服务可用后只打印 URL；对同一实例重复启动只会打印正在运行的 URL。这些运行时文件由 `tracker/.gitignore` 忽略。
- 服务只监听 loopback。绑定回环地址时，`Host` 头不是 `127.0.0.1`、`localhost`、`[::1]` 会返回 403（防 DNS rebinding）；写请求的 `Origin` 同样接受这三种写法（端口须一致）。Dockerfile 里的 `HOST=0.0.0.0` 没有任何认证，只应在容器内使用，并把端口只发布到本机：`docker run -p 127.0.0.1:4173:4173 ...`。

让游戏仓库内的 Agent 使用此实例的当前 Skill，有两种方式，`tt` 都能找到实例（见下文"`tt` 如何找到实例"），**不需要任何 junction 或符号链接**：

- **复制**（`gd-skill activate --tracker <实例>` 的做法）：把 `.agents/skills/game-task-hub` 复制到 `<game>/.claude/skills/game-task-hub`，并写入 Skill 目录内的 `tracker.json`（`{"dir": "<实例绝对路径>"}`）和项目根的 `.tt-dir`（一行，绝对路径）。
- **链接**（开发 Skill 时更方便）：

```bash
node scripts/link-game-skill.mjs /absolute/path/to/game-repository [--agents] [--no-claude] [--force]
```

Windows 上创建**目录 junction**（不需要管理员权限或开发者模式），macOS/Linux 上创建符号链接，默认链接到 `<game>/.claude/skills/game-task-hub`（Claude Code 读取的位置）；`--agents` 额外链接 `<game>/.agents/skills/game-task-hub`（Codex）。重复执行是幂等的；目标已经是指向别处的链接时需要 `--force` 才会改指；真实目录/文件永远不会被替换；失败时不会留下空目录。链接路径会写入 `<game>/.git/info/exclude`。

## Agent 命令行 `tt`

Agent 不需要手写 HTTP。`tt`（零依赖、Node ≥ 22）位于 Skill 内 `.agents/skills/game-task-hub/scripts/tt.mjs`（实例根目录另有入口 `scripts/tt.mjs`），按下面的顺序定位实例，读取 `tracker/.tracker-url`（环境变量 `TT_URL` 可覆盖服务地址），服务未启动时自动后台启动；自动补全 `Origin`/`Content-Type`，**每次写入前重读 `trackerRevision`**，对 409（revision 过期、锁被占用）和 Windows 的 `EPERM`/`EBUSY` 自动重试（最多 6 次）；中文参数与输出按 UTF-8 处理。输出是简短的单行文本，`--json` 输出原始 JSON；错误格式为 `tt: <出了什么问题> - <原因> - try: <下一条命令>`，退出码 1。

**`tt` 如何找到实例**（Skill 可以只是游戏里的一份复制，所以不依赖链接）。依次尝试，第一个指向有效实例（有 `server.mjs` 和 `task-hub.config.json`）的位置生效；`tt doctor` 会打印哪一步生效、前面几步为什么没有生效：

1. 环境变量 `TT_DIR`（写错是报错，不会悄悄换别处）；
2. Skill 的 `scripts/` 旁边的 `tracker.json`：`{"dir": "<绝对路径>"}`；
3. 当前目录向上、最近的含 `AGENTS.md` 或 `.git` 的目录里的 `.tt-dir`（第一行非空行，绝对路径；再往外层同类目录继续找）；
4. 同一目录旁边的兄弟目录 `<目录名>-Tracker`；
5. `tt.mjs` 自身的真实路径位于某个实例内（旧行为，也覆盖 junction/符号链接安装）。

指针文件必须写绝对路径：相对路径会让克隆来的仓库把 `tt` 指向它自带的脚本，所以会被拒绝。

标准流程（普通任务 2 条命令；每个 Story 的集成验收任务 3 条）：

```text
tt import docs/tasks/m1.md --admit-first          # 创建 Story/Task（Authority: checks | reviewer | owner），admit 第一个可执行任务
tt start                                          # 省略 ID = 领取下一个可领取任务；开启 Run，打印验收与 SpecRef，并记录 git HEAD
tt done "完成抛竿并验证"                           # checks 任务：附上较新的 reports/last-check.md，含 RESULT: PASS 即直接 Done；省略 ID = 你唯一的活跃 Run；打印下一个任务
...                                               # 同一个 Story 的集成验收任务（reviewer）：tt done -> In Review
tt show S-FISH                                    # 评审人一次读完：子任务、权属、artifact、auto-accepted 标记、git 差异范围
tt review T-003 approve "核对了验收条件" --as NAME  # 每个 Story 一次独立评审
```

| 命令 | 作用 |
| --- | --- |
| `up` · `down` · `url` · `status [--brief]` · `doctor` | 服务生命周期、概况、自检（过期锁、BOM/CRLF、版本不一致） |
| `ls [--status S] [--milestone M] [--type T] [--parent ID]` · `show ID` · `next` | 列表（每行一个任务）、紧凑任务包（≤ 40 行）、下一个可领取任务或"为什么没有"。`show STORY` 改为 Story 评审摘要：集成评审状态、每个子任务的权属/最新 Run/artifact 名/`auto-accepted`，以及 `diff range <最早 base>..<最晚 head>` |
| `evidence ID [--run RUN] [--name NAME]` | 打印一个 artifact（默认：最新有 artifact 的 Run 里通过检查的那份），超过 8 KB 截断并给出完整文件路径 |
| `import FILE [--dry-run] [--admit-first]` | 按任务集格式批量创建（幂等，已存在的 ID 跳过且不修改；循环依赖/未知依赖/缺少集成验收任务在写入前报错） |
| `new ID "标题" --accept "…" [--type Task\|Bug\|Story] [--parent S] [--deps "A;B"] [--auth reviewer\|checks\|owner] [--prio P1] [--milestone M] [--stream X] [--spec PATH]` | 创建单个工作项（Backlog）；Story 缺少覆盖全部 checks 任务的 reviewer 任务时，输出 `warning:`（不拒绝，因为计划总要先建 checks 任务） |
| `admit` · `park` · `block ID "原因"` · `unblock` | 状态流转 |
| `start [ID] [--profile …] [--scope …] [--expect …]` | 领取；省略 ID 时领取 `next` 给出的任务（没有已 admit 的任务且**恰好一个** Backlog 任务依赖都已 Done 时，就 admit 并领取它；0 个或多个候选时拒绝并列出，不替你选）；必要时先 admit，并打印验收与 SpecRef（同一 Agent 重复执行是幂等的，打印已有 Run）；在 git 仓库里把当前 HEAD 记为 Run 事件 `GITREV base=<sha>` |
| `event ID [RUN] TYPE RESULT "说明"` · `art ID [RUN] NAME FILE\|-` | 事件与文本证据（≤ 128 KB，同名不同内容会自动改名） |
| `done [ID] ["摘要"] [--next] [--evidence FILE]… [--no-evidence] [--outcome verified\|blocked\|incomplete\|awaiting-human] [--blocker …] [--owner-status …]` | 先存证据再关闭 Run；`reports/last-check.md` 比 Run 开始时间新时自动附加；`DecisionOwner` 任务默认 `awaiting-human`。省略 ID = 本 Agent 唯一的活跃 Run（第一个词若像任务 ID 但 Hub 不认识则报错，否则整句作摘要）。**checks 任务**先在本地预检：含 `RESULT: FAIL` 的文件不会上传，没有 `RESULT: PASS` 行则拒绝并告诉你该运行什么；通过则直接 `Done`，输出 `auto-accepted` 并打印下一个任务（`--next` 则在同一条命令里直接领取它，等于再执行一次 `start`，一串 checks 任务每个只需一条命令）。关闭前记录 `GITREV head=<sha> dirty=<bool>` |
| `review ID approve\|reject\|block "说明" [--as NAME]` | claim + decision 一步完成；评审名默认 `reviewer-xxxx`（或 `TT_REVIEWER`），与实现者重名（忽略大小写/空格）会被本地和服务器同时拒绝 |
| `eval ID approve\|resume\|block\|defer\|return "说明"` | 处理 Owner 反馈（任务处于 `Awaiting Agent Evaluation`）：`DecisionOwner` 任务走 owner-evaluation，评审权属任务走 owner-feedback-disposition（只能 `resume`/`block`/`return`，不能凭反馈直接通过） |
| `issue ID "摘要" --key K --toolchain T --op O` | 工具链故障上报（稳定 key，如 `godot.headless.import-timeout`） |

环境变量：`TT_AGENT`（实现者名，默认 `claude`）、`TT_REVIEWER`、`TT_URL`、`TT_DIR`。文本参数写成 `"@文件.md"` 时从文件读取。PowerShell 5.1 若把中文输出显示成 `?`，先执行 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；Git Bash 无此问题。

**任务集格式**（`docs/tasks/<milestone>.md`，`tt import` 读取；导入后任务*状态*以 Hub 为准，文档只保留任务*意图*）：

```markdown
# Tasks: M1 原型
Milestone: M1
Stream: 玩法                  <!-- 默认 Workstream，可选 -->
Lane: slice                   <!-- slice 进入 Hub；prototype 只是清单，tt import 会拒绝 -->
Spec: docs/milestones.md#m1   <!-- Story 的默认 SpecRef，可选 -->

## S-FISH: 抛竿与收线原型        <!-- "## ID: 标题" = Story -->
- Acceptance: 玩家可观察的整体结果（一段话）
- Spec: docs/systems/cast-reel.md

### T-001: 抛竿动作              <!-- "### ID: 标题" = Task；加 "- Type: Bug" 为 Bug；父级 = 最近的前一个 Story 或 "- Parent:" -->
- Depends: T-000; T-002         <!-- 可选，";" 或 "," 分隔 -->
- Authority: checks             <!-- checks（检查通过即完成）| reviewer（默认，独立评审）| owner（人类试玩/取舍） -->
- Priority: P1
- Acceptance: 玩家可观察的结果
- Effort / Profile / Why / Decisions / Uncertainty: 仅作文档备注，不进入 Hub
```

**每个 Story 一次评审**：只要 Story 有 `checks` 任务，就必须有一个 `reviewer` 子任务（集成验收任务）直接或经其他任务间接依赖其**全部** `checks` 任务；`tt import` 在写入前报错（`tt new` 与 `tt doctor` 给出警告，看板也会列出）。已存在于 Hub 的任务也计入这张图，只检查本次导入触及的 Story。

规则：ID 形如 `T-001`（`[A-Z][A-Z0-9]*-[A-Za-z0-9-]+`，Windows 保留名不可用，且忽略大小写后必须唯一）；任务 `SpecRef` 默认是 `<文档路径>#<小写 ID>`；多行值折叠为一行；先建 Story，再按 `Depends` 拓扑序建 Task；全部以 Backlog 创建，`--admit-first` 额外 admit 第一个可执行任务；全文件检查通过后才开始写入。

## 升级既有实例

模板先完成并验证通用改动后，先对既有实例做无写入检查，再由明确的 `--apply` 同步。同步器只处理声明的模板代码、网页、文档、Skill、测试和 skeleton；它绝不写入 `tracker/` 或 `task-hub.config.json`，遇到目标 symlink 会拒绝操作。

```bash
node scripts/sync-template.mjs --target /absolute/path/to/existing-game-tracker
node scripts/sync-template.mjs --target /absolute/path/to/existing-game-tracker --apply
```

同步后在实例仓库运行其测试，并按需要重启本地服务。实例的 Git 提交策略、任务状态和证据仍由该实例单独管理；不要把它们合入模板仓库。

## 工作项类型与层级

标准 CSV 为 19 列，包含必填的 `TaskType`（`Task`、`Bug`、`Story`）和 `CompletionAuthority`。`Task` 和 `Bug` 是可执行工作项；其完成权属只能是 `IndependentReviewerAgent`（独立 Reviewer Agent 批准才可 Done）、`RunEvidence`（导入器/CLI 写作 `checks`：Run 里有通过的检查结果即可 Done，见下文）或 `DecisionOwner`（Human Decision Owner 的已记录决定才可 Done）。`Bug` 仅用于明确标记缺陷，不会绕开正常的依赖、Run 与独立审查流程。

`Story` 是远期或较大功能的不可执行范围容器：必须没有 `ParentID`、`DependsOn`，且 `CompletionAuthority=NotApplicable`；它不能被 admit、claim、Run、review 或作为依赖。新建的 `Task`/`Bug` 的 `ParentID` 只能指向一个 Story，且不能依赖 Story。这样可以先记录目标，再在接近执行时拆出可验证子项，避免为远期功能过早制造细碎任务。Story 的 `Status` 不是独立可操作状态：直属 `Task`/`Bug` 非空且全部 `Done` 时派生为 `Done`（若它有 `RunEvidence` 子任务，还须有一个依赖全部这些子任务的 `IndependentReviewerAgent` 子任务，它 Done 即表示全部 Done），否则为 `Backlog`；新增直属子项会自动回到 `Backlog`。

旧 CSV 仍可读取，但新建任务前必须迁移。先以当前 revision 调用 `POST /api/tracker/task-types/migrate`（它显式写入 `TaskType=Task`，不猜测旧 `ParentID`；旧值会进入 Evidence），再调用 `POST /api/tracker/completion-authority/migrate`。后者以原位列替换将旧 `ReviewRequired=Yes` 映射为 `IndependentReviewerAgent`、`No` 映射为 `DecisionOwner`；Story 映射为 `NotApplicable`。规范 schema 不得同时保留两个列。

主 Milestone 看板会将直属 `Task`/`Bug` 缩进在 Story 的折叠组内；Story 行右侧显示直属子项的完成数，例如 `3 / 7 已完成`，全部完成显示 `✓ 7 / 7`，并显示派生的 `Done`。Milestone 状态统计只计可执行的 Task/Bug，另列 Story 数量，因此已完成 Story 不会制造“待排期”计数。这是范围拆分完成，不是玩家路径/集成验收。平铺的“全部任务审计表”仍保留，便于逐条检查。

`Milestone` 继续是交付窗口/分组，而不是 `TaskType`：它不拥有 claim、Run、依赖或 review 语义，因此不会和 Story 的范围层级重复。

## 状态、Run 与审查

Agent 先读取 `GET /api/tasks/<TaskID>/packet`。packet 给出任务、依赖/反向依赖、既有 Run 与当前 `trackerRevision`；所有任务写操作必须使用这个 revision、`Content-Type: application/json` 与同源 `Origin`（`127.0.0.1`、`localhost`、`[::1]` 加同一端口均视为同源）。缺少 `trackerRevision` 返回 400（`trackerRevision is required`），过期返回 409（`trackerRevision is stale (current: …)`，附当前值）。

这里的 revision 要求适用于任务写入；工具链事件使用独立的并发契约，见下文。任务包的 `packet.context.story` 带入已解析的父 Story 目标、Acceptance、SpecRef 与 Milestone；读取 Story 时，`context.children` 给出直接 Task/Bug 子项。Story 状态在读取时由同一 CSV 的直属子项投影，且只会随授权写入持久化，不会因 GET 改写 CSV；它不将 Story 变成执行依赖。将切片的行为契约放进 SpecRef，并设置明确的集成验收 Task；Story 的 `Done` 不能代替整体玩家路径验收。

普通实现只可从 `Ready` 的 `Task`/`Bug` 使用 `POST /api/runs/start` 领取。默认实例启用 `workflow.serialLane`：Hub 同时只允许一个 Agent 工作项（`IndependentReviewerAgent` 或 `RunEvidence`）处于 `Ready`、`In Progress` 或 `In Review`；Run 开始时，只会把唯一的直接后继从 `Backlog` 自动 arm 为 `Blocked`。更远的链路保持 `Backlog`。Hub 分配单调的 `TaskID-R0001`，使任务进入 `In Progress`，并在 `tracker/task-records/<TaskID>/<RunID>/` 保存 Run、事件与不可覆盖的文本 artifact。Run 关闭具有固定边界：

- `verified` → `In Review`，绝不自动 `Done`（唯一例外：`RunEvidence` 任务，见下一节）；
- `blocked` → `Blocked`，必须写明 blocker；
- `incomplete` → 保持 `In Progress`，并记录缺失证据；
- `awaiting-human` → 调用者必须显式提供 `ownerStatus: "Awaiting Owner"` 或 `"Awaiting Owner Gate"`；模板不会根据 Task ID 猜测项目流程。

Run claim/close 均保存可恢复 intent；预提交中断会留下不可复用的 `Abandoned` Run，CSV 已提交但 Run 未收尾时会在后续操作前恢复。文本 artifact 每份最多 128 KB、每 Run 最多 32 份/512 KB；可用安全相对路径如 `logs/engine.log`、`test-results.xml`、`evidence.md`。二进制、大型构建产物或截图应在 evidence 中记录仓库相对路径或 HTTPS 引用。

独立审查使用 `POST /api/tasks/<TaskID>/review`：reviewer 先 `action: "claim"`，再提交 `action: "decision"` 及 `approved`、`rejected` 或 `blocked`。reviewer 必须不同于 `Implementer` 以及所有曾在该任务上持有 Run 的 Agent（比较前先 trim、折叠空白、忽略大小写与全角差异，所以 `IMPL-LOCK` 不能评审 `impl-lock` 的任务；被放弃的 claim 不计）；批准才会进入 `Done`，可修复的拒绝回到 `Ready`，阻断审查需要具体 blocker。在 serial lane 中，批准只自动推进唯一且依赖齐全的直接后继；多个候选保持 `Backlog`，由有权限的调用方按项目 Gate 显式 admit，不会批量解锁。

状态语义分开使用：`Blocked` 表示已经纳入近期执行链、但有具体可行动的前置/环境/规则阻碍；`Backlog` 表示已规划但尚未纳入近期执行链的工作，不能出现在 blocker 监控里，也不能领取。不要把“未来 Milestone 尚未开放”写成 `Blocked`。

对于未领取的 `Ready` packet，Agent 可用 `POST /api/tasks/<TaskID>/block` 记录发现的矛盾或缺失条件，不创建 Run。通用 `POST /api/tasks/<TaskID>/unblock` 仅验证没有活跃 Run、所有直接依赖均为 `Done`、并记录理由；已经结束的 blocked Run 保留的历史 `Implementer` 不视为活跃 claim，成功解锁时会清空该陈旧字段。`POST /api/tasks/<TaskID>/park` 可把无 claim/active Run 的 `Blocked` 任务收回 `Backlog`；`POST /api/tasks/<TaskID>/admit` 把 `Backlog` 任务重新纳入近期链并显式设为 `Ready`（全部依赖已 Done 且 lane 空闲）或 `Blocked`（仅当唯一直接前置正在进行/Review，其他依赖 Done）。这些 API 不理解任何游戏特有的 Gate、Release 或产品决策规则。调用方必须先按该游戏自己的流程确认该状态转换被允许。

如果发现任务的 `Task`、`SpecRef` 或 `Acceptance` 与冻结架构相互矛盾，Agent 不得只在 Evidence 中重新解释旧要求，也不得直接编辑 CSV。可在任务没有活跃 Run 或 review claim，且状态为 `Backlog`、`Ready` 或 `Blocked` 时，使用 `POST /api/tasks/<TaskID>/contract` 提交完整替换后的三项字段、当前 revision、Agent 和具体修订理由。Hub 保留旧 Evidence，并追加字段清单、UTC 与理由；它不会改变状态、依赖、OwnerRole、优先级或审查历史。已 `In Progress`/`In Review`/`Done` 的任务必须通过新的补救任务处理，不可回写其完成时的契约。

如果新发现的前置条件必须进入既有、未启动任务的依赖图，使用 `POST /api/tasks/<TaskID>/dependencies`，提交当前 revision、Agent、具体理由和完整替换的分号分隔 `dependsOn`。该接口只接受没有活跃 Run 或 review claim 的 `Backlog` 或 `Blocked` 任务，拒绝已 `Ready`、活跃、审查中或完成的任务；已关闭 blocked Run 保留的历史 `Implementer` 不属于活跃 claim，不能阻止这类可审计修订。接口原子校验未知 ID、自依赖、重复依赖和环，并保留旧依赖与新依赖的 Evidence。不要通过直接编辑 CSV 规避该保护。

已完成/审查中的任务发现独立缺陷时，Agent 必须创建新的补救任务，不能回写旧任务。使用 `POST /api/tasks` 携带当前 `trackerRevision`、命名 Agent、创建理由，以及完整 `newTask`（`taskId`、必填 `taskType`、`milestone`、`workstream`、`task`、`specRef`、`dependsOn`、`ownerRole`、`priority`、`acceptance`、`completionAuthority`，可选 `parentId`）。`completionAuthority` 必须是 `IndependentReviewerAgent`、`RunEvidence`、`DecisionOwner` 或仅 Story 可用的 `NotApplicable`。Hub 只创建 `Backlog`（Story 还缺集成验收任务时，响应带 `warnings`，但不拒绝）：它会原子校验完整依赖图、拒绝重复 ID/未知依赖/环，并写入 `CREATED` Evidence。随后仍必须按项目 Gate 和普通 `/admit` 流程纳入近期执行链；创建接口不能伪造 `Ready`、执行者、审查或完成状态。

Owner 反馈仍只作为原始 Evidence 写入，并转为 `Awaiting Agent Evaluation`（界面文案为“Owner 反馈待 Agent 处置”）；它不会自动完成任务、批准 Gate、评审实现或解锁依赖。这个状态不等待某个常驻 Coordinator，也不会等待已结束的 Implementer；任意 Agent 只要在 mutation 中提供 `actor`，即可留下可审计的处置。

`CompletionAuthority=DecisionOwner` 的任务只可使用 `POST /api/tasks/<TaskID>/owner-evaluation` 记录 `approved`、`blocked`、`deferred` 或 `return-to-owner`。`CompletionAuthority=IndependentReviewerAgent` 的 Task/Bug 不可走该路线：使用 `POST /api/tasks/<TaskID>/owner-feedback-disposition`，提交 `{ trackerRevision, actor, action, reason }`，其中 `action` 为：`resume`（需无 active Run/review claim、直接依赖 Done 且 serial lane 空闲，回到 `Ready` 并清除旧 Implementer）、`blocked`（另需具体 `blocker`）或 `return-to-owner`（另需 `ownerStatus` 为 `Awaiting Owner`/`Awaiting Owner Gate`）。三种结果均写入 Evidence；`resume` 后仍必须新建 Run 并经过独立 review 才能 Done。

首页“需要你处理”只计入 `Awaiting Owner` / `Awaiting Owner Gate`；反馈后的 `Awaiting Agent Evaluation` 进入“当前 Agent 工作”，任务详情仍允许补充反馈。自动排队且前置仍活跃的 Blocked 项单列为“正常依赖等待”，不混进“需处理的阻塞”；自定义或未知 blocker 保守地保留在需处理列表。此展示不更改 CSV 状态。历史 ARMED 文本不能覆盖后来新增的独立 blocker，自动推进/撤销也遵循这一边界。

角色不是长期任务分配：Human Decision Owner 是人的决策权属；Implementer Agent 只在其受管 Run 存活时拥有执行 claim；Independent Reviewer Agent 只在其 claimed review 存活时拥有审查权；`actor` 只是某次状态转换的审计身份。不要为 Coordinator 建立字段、assignee 或等待条件，也不要通过改 completion authority 规避独立审查。

当持有活跃 authority Run 的 Agent 需要在其任务完成前，将其直接依赖的一项、未领取的 `DecisionOwner` `Backlog` 工作暴露给 owner 时，使用 `POST /api/tasks/<TaskID>/owner-wait`。调用必须明确给出 `ownerStatus`（`Awaiting Owner` 或 `Awaiting Owner Gate`）、具体理由、活跃的 `authorityTaskId` 与相同的认领 Agent 身份。Hub 会核验 authority task 是该目标的直接依赖，且该 Agent 拥有其活跃 Run；不会从 Task ID 或 Milestone 推断语义。这让 Human/owner 准备可审计地进入等待，且不会手改 CSV 或提前把 authority task 标为 Done。

首页在“当前 Agent 工作”和 Milestone 视图之间提供“可领取的 Session”面板。它只列出 CSV 状态为 `Ready` 的 `Task`/`Bug`，方便确认下一项可被 Agent 领取的工作；点击任务可查看依赖、验收与证据。面板不替代领取 API：真正领取时仍由 Hub 使用最新 revision 再次验证 `Ready` 状态和全部直接依赖。

## 检查证据完成（RunEvidence）与每个 Story 一次评审

给每个任务各配一个独立评审 Agent 太慢也太贵，所以普通实现任务改为**以机器可检查的 Run 证据完成**，由 Story 的集成验收任务做**一次**独立评审。

- **`CompletionAuthority=RunEvidence`**（导入器/CLI 写作 `checks`；仅 Task/Bug，Story 仍是 `NotApplicable`）。Run 以 `verified` 关闭时，该 Run 须至少有一份文本 artifact 匹配 `workflow.runEvidencePattern`（正则，默认 `^RESULT: PASS\b`，多行匹配；配置里没有这个键就用默认值，`init-instance` 会显式写出；无效正则会让服务启动失败并说明原因），且没有任何 artifact 匹配 `^RESULT: FAIL\b`。满足时任务**直接 `Done`**（不经过 `In Review`），Evidence 追加一行 `auto-accepted: RunEvidence (<RunID>, artifact <名称>)`，serial lane 的后继像评审通过后一样自动推进。不满足返回 422（`run-evidence-missing` / `run-evidence-failed`），提示“运行项目检查使 reports/last-check.md 含 RESULT: PASS，或以 incomplete 关闭”。`blocked`、`incomplete`、`awaiting-human` 与以前一致；`RunEvidence` 任务不能走 review 接口。
- **项目检查脚本**（`tools/check.ps1`）写出的 `reports/last-check.md` 总含一行 `RESULT: PASS (...)` 或 `RESULT: FAIL (...)`；`tt done` 在上传前本地检查同一条件，所以失败的检查不会污染 Run（artifact 不可覆盖）。
- **Story 约束**：见上文“每个 Story 一次评审”。服务端同时把它做成状态规则：带 `RunEvidence` 子任务的 Story 没有覆盖它们的 `reviewer` 子任务就不会派生为 `Done`；`GET /api/summary` 的 `storyReview.gaps` 列出违规的 Story，`storyReview.open` 列出集成验收尚未完成的 Story。看板有对应面板，自动验收的 Done 任务带“检查自动验收”标记。
- **评审人读什么**：`tt show <StoryID>`（即 `GET /api/tasks/<StoryID>/packet` 的 `context.children/review/gitRange`）一次给出子任务、权属、Run、artifact 名、auto-accepted 标记和 git 差异范围；`tt evidence` 读单个 artifact。`tt start` / `tt done` 在 git 仓库里把 HEAD 记为 Run 事件 `GITREV base=<sha>` / `GITREV head=<sha> dirty=<bool>`（尽力而为；不在 git 仓库里就不记录），`tt show` 打印最早 base 到最晚 head 的 `diff range`。评审独立性沿用原规则（评审名与该任务的实现者归一化后不能相同）。
- **配置**：`task-hub.config.json` 的 `workflow.runEvidencePattern`（示例见 `task-hub.config.example.json`）；`/api/health` 公布当前模式，`tt` 用它做本地预检。

## 工具链问题看板

`tracker/toolchain_issue_events.jsonl` 是跨任务工具链健康事件的追加式权威，不是第二套任务状态。Agent 在某一 Task/Run 上遇到可复现的工具链故障时，调用 `POST /api/toolchain-issues`，至少提供 `{ taskId, runId?, failureKey, reporter, toolchain, operation, summary }`；`failureKey` 必须是稳定小写标识符，例如 `godot.headless.import-timeout`，不能用含时间戳、绝对路径或原始错误全文的字符串。

看板按 `failureKey` 聚合多个任务的报告。Owner 使用 `POST /api/toolchain-issues/<failureKey>/ack` 提交 `{ acknowledger, notes, expectedReportCount }`，其中 `expectedReportCount` 必须是刚查看的该问题 `totalReportCount`。缺少/非法计数返回 400；期间有新报告则返回 409 且不写 ACK，需刷新并查看新报告后再确认。旧 ACK 调用方必须补充此字段；报告接口不变。ACK 是确认/处理动作，不等于已经修复，也不改变任务状态或解除 blocker。

ACK 后问题从默认看板隐藏但历史不删除；同一 key 重现时显示 `1 (5)`，分别表示 1 个新报告和此前已 ACK 的 5 个报告。使用页面“包含已 ACK 的历史”或 `GET /api/toolchain-issues?includeAcknowledged=true` 可审计历史聚合项。报警源读取失败会明确显示不可用，任务看板仍可加载；不可用不显示为零报警。一次命令的轮询不是多次故障报告，告警计数也不是独立根因数。

## 跨平台注意事项（Windows / macOS / Linux）

Hub 只依赖 Node ≥ 22，没有 PowerShell/sh 依赖。GitHub Actions（`.github/workflows/test.yml`）在 ubuntu、macos、windows 上各运行一遍 `node scripts/test-all.mjs`。随平台不同的行为集中在 `scripts/lib/platform.mjs`，测试可以注入平台（`TASK_HUB_TEST_PLATFORM`，只在 `NODE_ENV=test` 时生效），所以 POSIX 分支在 Windows 上也有单元测试；只有真实 macOS/Linux 才能证明的部分（文件系统、信号、进程行为）由 CI 承担。无法在当前系统运行的用例会打印 `SKIP: 原因`，`test-all.mjs` 在汇总里列出。失败时 `test-all.mjs` 末尾给出摘要（失败的套件、第一条失败断言、该套件输出的最后 15 行），CI 里的 `scripts/ci-annotate.mjs` 把它变成 GitHub annotations 并附上机器描述（系统、用户是否管理员、临时目录是否 8.3 短路径、git 配置、能否创建目录符号链接、4300–4999 里可绑定的端口）；任务日志需要登录才能看，annotations 不需要：`GET /repos/<owner>/<repo>/check-runs/<job id>/annotations`。

- **所有系统**：TaskID/RunID 忽略大小写必须唯一（`T-001` 与 `t-001` 在 Windows 和默认的 macOS 上是同一个目录，返回 409 `duplicate-id`），Windows 设备名在所有系统上都被拒绝，这样仓库可以在系统之间移动；锁文件的主机比较只看第一段主机名（macOS 会随网络在 `Mac.local` 与 `Mac.lan` 之间变化）；`SIGTERM`/`SIGINT` 让服务干净退出并删除 `.tracker-url`/`.tracker-pid`，强杀留下的旧文件会被下次启动覆盖。
- **仅 Windows**：rename/读取/建锁遇到 `EPERM`/`EBUSY`/`EACCES` 会重试；macOS 和 Linux 上这些错误码是真正的权限错误，立即失败并提示检查目录权限。`link-game-skill` 在 Windows 用目录 junction，在 macOS/Linux 用符号链接。

下面这些问题在 Windows 上实测出现过，现在都有回归测试：

- **网页样式**：静态资源的目录包含判断改为与路径分隔符无关（之前 `/app.js`、`/styles.css` 在 Windows 上返回 403，页面没有样式）；目录、设备名（`NUL`、`CON`）一律 404，路径穿越仍被拒绝。
- **写入健壮性**：原子替换（rename）遇到杀毒软件/索引器/读取方的短暂句柄（`EPERM`/`EBUSY`/`EACCES`）时最多重试 8 次（约 2 秒，仅 Windows）；锁文件记录 `{pid, host, createdAt}`，持有者进程已不存在（或锁超过 120 秒）时自动替换，真正被占用时的 409 会写明持有者与时长，不再需要手动删除 `.lock`。
- **CSV**：读取时去掉 UTF-8 BOM（Excel 的 "CSV UTF-8"）并接受 CRLF；写入统一为 LF、无 BOM。仓库带 `.gitattributes`（`* text=auto eol=lf`），避免 `core.autocrlf=true` 把 shebang 和 skeleton 变成 CRLF。
- **TaskID / RunID**（保留名所有系统都拒绝，忽略大小写唯一，见上）：会成为 `tracker/task-records/` 下的目录名，所以拒绝 Windows 设备名（`CON PRN AUX NUL COM1-9 LPT1-9`，大小写不限、可带扩展名）、以 `.` 结尾或全是点的 ID。
- **错误信息**：客户端错误一律返回 4xx 并指出缺少/非法的字段，不再返回 500（空/`null` 请求体、非 UTF-8 请求体、非法 `%` 编码、未知依赖、缺少的 Run/artifact、缺少 `agent`/`reviewer` 字段）；`DependsOn` 相关错误提示用 `;` 分隔；意外的 500 不会泄露绝对路径。
- **PowerShell 5.1**：`curl.exe -d` 和 `Invoke-RestMethod` 会弄坏 JSON 引号和中文，请用 `tt`、Node `fetch` 或 UTF-8 文件；`.ps1` 脚本必须是纯 ASCII（或带 BOM）。

## 验证

```bash
node --check server.mjs
node --check public/app.js
node scripts/test-all.mjs             # 依次运行下面所有测试，每个套件一个进程，任何失败则退出码为 1
```

也可单独运行：

```bash
node scripts/test-managed-runs.mjs
node scripts/test-serial-lane.mjs
node scripts/test-dependency-audit.mjs
node scripts/test-task-types-and-toolchain-issues.mjs
node scripts/test-delivery-context.mjs
node scripts/test-template-sync.mjs
node scripts/test-static-assets.mjs        # Windows 静态资源、Content-Type、路径穿越
node scripts/test-windows-robustness.mjs   # rename 重试、陈旧/占用锁、BOM+CRLF、保留名、评审身份归一化
node scripts/test-http-hardening.mjs       # Origin 别名、Host 校验、无 500 的客户端错误、revision 必填/过期、artifact 与错误安全
node scripts/test-agent-api.mjs            # /api/health、/api/tasks 过滤、/api/next 原因
node scripts/test-start-init.mjs           # 固定端口、.tracker-url/.tracker-pid、start --detach、init --empty/--port
node scripts/test-link-game-skill.mjs      # junction/符号链接、幂等、拒绝外部目标/真实目录、git exclude
node scripts/test-taskset.mjs              # 任务集解析、排序、错误
node scripts/test-tt.mjs                   # tt 端到端（含带空格和中文的路径、并行写入、强杀服务、junction）
node scripts/test-skill.mjs                # Skill 预算（≤ 5 KB、≤ 80 行）、链接只在 Skill 目录内、命令与接口、错误码文档不漂移
node scripts/test-platform.mjs             # 可注入的平台分支：Windows 重试 vs POSIX 立即失败、主机名容忍、保留名与忽略大小写的唯一 ID
node scripts/test-run-evidence.mjs         # checks 完成、FAIL/缺证据被拒、serial lane 推进、Story 评审约束与 Story 摘要、配置、旧 CSV
node scripts/test-tt-story.mjs             # checks 与 Story 评审端到端：导入约束、tt done、GITREV、tt show STORY、tt evidence
node scripts/test-discovery.mjs            # tt 无链接发现实例：TT_DIR、tracker.json、.tt-dir、兄弟目录、tt.mjs 位置
node scripts/test-ci-annotate.mjs          # CI 失败通道：摘要、annotation 转义与数量上限、套件输出不会变成工作流命令、workflow 接线（仅模板仓库）
```

所有测试均使用临时 CSV/临时实例，不会写当前实例的 Tracker；类型/工具链测试验证旧 schema 的两步迁移、Story 执行防护/上下文、跨任务告警聚合、过期 ACK 拒绝与重现计数。交付上下文测试覆盖 Owner/Agent 交接、三种反馈处置、独立审查、Story 的派生完成/重开、正常依赖等待与历史标记不覆盖新 blocker。`scripts/lib/test-support.mjs` 是各测试共用的启动/临时实例辅助模块。
