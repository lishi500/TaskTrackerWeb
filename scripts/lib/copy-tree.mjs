// Recursive copy built from the small fs primitives (stat, readdir, mkdir, copyFile). Node's own cp/cpSync
// moved into C++ on some Node 22 versions, and a native failure on Windows (a destination path with
// non-ASCII characters on a machine whose system code page cannot hold them) ended the whole process with
// exit code 0xC0000409 and no output. These primitives are the ones everything else in the Hub already uses.
//
//   copyTree(from, to, { filter, preserveTimestamps })
//     from       a file or a folder; a folder is copied with its content, merged into an existing `to`
//     filter     (source, destination) => boolean, like fs.cp: false skips that file or folder
//     preserveTimestamps  keep the modification time of every copied file and folder
// Symbolic links (and junctions) are refused, not followed: nothing the Hub copies contains one.

import { copyFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function copyTree(from, to, { filter = () => true, preserveTimestamps = false } = {}) {
  if (!filter(from, to)) return;
  const info = statSync(from);
  if (info.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`copyTree does not copy symbolic links or junctions (${join(from, entry.name)})`);
      copyTree(join(from, entry.name), join(to, entry.name), { filter, preserveTimestamps });
    }
  } else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  if (preserveTimestamps) utimesSync(to, info.atime, info.mtime);
}
