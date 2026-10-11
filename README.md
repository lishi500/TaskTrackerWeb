# Task Tracker Web

这是可 clone 的**单游戏任务中枢实例**。一份 TaskTrackerWeb Git 项目只管理一个游戏；该实例的 `tracker/task_tracker.csv` 是唯一当前任务状态数据源，网页不保留独立数据库或任务副本。

启动：

```bash
node scripts/init-instance.mjs --project-id my-game --project-name "My Game"
node scripts/start.mjs
```

启动脚本默认选择空闲端口并打印 URL。可用 `PORT=4300` 固定端口。`TRACKER_CSV` 仅用于迁移/测试时临时覆盖，不是多项目管理机制。

## 新游戏的正确用法

1. 从此仓库创建一个独立的 `<Game>-Tracker` Git 项目；不要把它嵌入游戏代码仓库。
2. 在该实例根目录运行初始化命令。它只创建 `tracker/` 下的数据，不会覆盖已有 tracker。新的 CSV 来自 [task skeleton](templates/task_tracker.skeleton.csv)；在把它当作真实项目状态前，先替换四条 `BACKLOG-001`/`DEC-001`/`IMPL-001`/`REV-001` 示例行。
3. 需要让游戏代码 Agent 发现本实例的 Skill 时，运行 `node scripts/link-game-skill.mjs /absolute/path/to/game-repository`。这会创建一个指向本实例 Skill 的符号链接，因此 Skill 更新会立即生效。
4. 提交该 Tracker 项目的 `tracker/task_tracker.csv`、`task_events.jsonl` 和 `task-records/`；游戏仓库与 Tracker 仓库保持独立。

网页会顶置三类信息：等待 owner 处理的事项、Agent 正在处理的任务、以及阻塞任务。对 `Awaiting Owner`、`Awaiting Owner Gate` 或已经 `Awaiting Agent Evaluation` 的任务，详情中可以提交反馈。

提交反馈时，服务会获得一个短暂的同目录独占锁，并先拒绝任何列数不等于 header 的 CSV 行；仅在结构完整时才将 `[OWNER FEEDBACK <UTC>]` 原文追加到该行 `Evidence`，把状态设为 `Awaiting Agent Evaluation`，并以临时文件原子替换 CSV。它不会自动写 `Done`、解锁任何依赖、或将 owner 文本解释为 Gate/产品决定。后续 Agent 必须依照 `AGENTS.md` 和 `docs/handoff_operating_model.md` 评估并完成权威状态转换。

本服务默认仅监听 `127.0.0.1`；没有认证，不应暴露到局域网或公网。写入接口要求同源 `Origin: http://127.0.0.1:<port>` 和 `Content-Type: application/json`，拒绝跨站/simple POST。
