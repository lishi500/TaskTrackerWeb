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

## How `tt` finds the tracker (no link needed)
The skill in a game may be a plain COPY. `tt` takes the first of these that names a folder holding `server.mjs` and `task-hub.config.json`; `tt doctor` prints which one won and why the earlier ones did not:
1. env `TT_DIR` (a wrong value is an error, not a hint);
2. `tracker.json` beside the skill's `scripts/` folder: `{"dir": "<absolute path>"}`;
3. `.tt-dir` (first non-empty line, an absolute path) in the nearest folder above the current directory that has `AGENTS.md` or `.git` (then in the outer ones);
4. the sibling `<that folder's name>-Tracker`;
5. the real location of `tt.mjs` inside an instance (`<instance>/.agents/skills/game-task-hub/scripts`, which also covers a link).
Pointer files must hold absolute paths (a relative one would let a cloned repository steer `tt` at scripts it ships). `TT_URL` still overrides the server URL.

## Link the skill into a game (optional)
```text
node scripts/link-game-skill.mjs <gameDir> [--agents] [--no-claude] [--force]
```
Creates `<gameDir>/.claude/skills/game-task-hub` (`--agents` adds `.agents/skills/...` for Codex). Windows uses a directory junction (no admin rights needed), macOS and Linux a symlink. Re-running is a no-op; a link to somewhere else needs `--force`; a real directory is never replaced. The path is added to `.git/info/exclude`.

## Upgrade an instance from the template
```text
node scripts/sync-template.mjs --target <instance>            preview, writes nothing
node scripts/sync-template.mjs --target <instance> --apply
```
Never touches `tracker/` or `task-hub.config.json`. Restart the server afterwards (`tt down`, then any `tt` command). `tt` warns when its version differs from the server's.

## Legacy schema
Inspect first; do not migrate just to look. In order: `POST /api/tracker/task-types/migrate` then `POST /api/tracker/completion-authority/migrate`, each with `{trackerRevision, actor, reason}` (re-read the revision between them). The second replaces `ReviewRequired` with `CompletionAuthority` (`Yes` -> `IndependentReviewerAgent`, `No` -> `DecisionOwner`, Story -> `NotApplicable`).

## Platform notes (Windows, macOS, Linux)
- CSV files saved by Excel (UTF-8 BOM, CRLF) are read as they are; the next Hub write converts to LF without BOM.
- Task and Run ids become folder names. They must be unique ignoring case (Windows and default macOS folders are case-insensitive), and Windows device names (`NUL`, `CON`, `COM1`...) and trailing dots are rejected on every OS so a repository can move between systems.
- Windows only: if a write fails with `EPERM`/`EBUSY`, an antivirus or indexer held the file; the Hub already retried for about 2 s. On macOS and Linux those codes are real permission errors and fail at once.
- macOS reports the machine as `Mac.local` or `Mac.lan` depending on the network; a lock held by this machine under either name is recognised.
- PowerShell 5.1 prints UTF-8 as `?` unless `[Console]::OutputEncoding = [Text.Encoding]::UTF8` is set first; Git Bash, zsh and bash are fine.
- `SIGTERM`/`SIGINT` stop the server cleanly (it removes `tracker/.tracker-url` and `.tracker-pid`); a hard kill leaves them and the next start replaces them.
