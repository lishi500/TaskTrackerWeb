#!/usr/bin/env node
// Convenience entry: `node scripts/tt.mjs <command>` from the tracker instance root.
// The CLI itself lives inside the skill, which may be a copy, a junction or a symlink; tt.mjs finds the instance by itself.
import '../.agents/skills/game-task-hub/scripts/tt.mjs';
