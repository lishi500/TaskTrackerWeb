# Setup and maintenance (only when needed)

Normal task work needs none of this: `tt up` starts the server by itself.

## New instance
```text
node scripts/init-instance.mjs --project-id my-game --project-name "My Game" --empty --port 4321
node scripts/start.mjs --detach          prints the URL; the server keeps running in the background
```
`--empty` writes only the CSV header (without it the illustrative skeleton rows are copied; replace them before real use). Without `--port` a stable port in 4300-4999 is derived from the project id and written to `task-hub.config.json` (`instance.port`). The initializer refuses an existing tracker. Keep the unauthenticated service on loopback.

## Runtime files (`tracker/`, never committed)
`.tracker-url` and `.tracker-pid` are written by the server after it listens and removed on a clean exit; after a hard kill they are stale and the next start replaces them. `server.log` holds the detached server's output. `*.lock` files are replaced automatically when their holder is dead or older than 120 s. `tt doctor` reports all of these.

## Link the skill into a game
```text
node scripts/link-game-skill.mjs <gameDir> [--agents] [--no-claude] [--force]
```
Creates `<gameDir>/.claude/skills/game-task-hub` (`--agents` adds `.agents/skills/...` for Codex). Windows uses a directory junction (no admin rights needed), POSIX a symlink. Re-running is a no-op; a link to somewhere else needs `--force`; a real directory is never replaced. The path is added to `.git/info/exclude`.

## Upgrade an instance from the template
```text
node scripts/sync-template.mjs --target <instance>            preview, writes nothing
node scripts/sync-template.mjs --target <instance> --apply
```
Never touches `tracker/` or `task-hub.config.json`. Restart the server afterwards (`tt down`, then any `tt` command). `tt` warns when its version differs from the server's.

## Legacy schema
Inspect first; do not migrate just to look. In order: `POST /api/tracker/task-types/migrate` then `POST /api/tracker/completion-authority/migrate`, each with `{trackerRevision, actor, reason}` (re-read the revision between them). The second replaces `ReviewRequired` with `CompletionAuthority` (`Yes` -> `IndependentReviewerAgent`, `No` -> `DecisionOwner`, Story -> `NotApplicable`).

## Windows notes
- CSV files saved by Excel (UTF-8 BOM, CRLF) are read as they are; the next Hub write converts to LF without BOM.
- Task and Run ids become folder names, so Windows device names (`NUL`, `CON`, `COM1`...) and trailing dots are rejected.
- PowerShell 5.1 prints UTF-8 as `?` unless `[Console]::OutputEncoding = [Text.Encoding]::UTF8` is set first; Git Bash is fine.
- If a write fails with `EPERM`/`EBUSY`, an antivirus or indexer held the file; the Hub already retried for about 2 s.
