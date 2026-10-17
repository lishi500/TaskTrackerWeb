// Everything that behaves differently per operating system lives here, parameterised by
// `platform` ('win32' | 'darwin' | 'linux'), so every branch can be unit-tested on any machine
// (see scripts/test-platform.mjs). The server and the scripts import these helpers instead of
// testing process.platform inline. skill/tt.mjs must stay self-contained and keeps its own
// copies of the few it needs; scripts/test-platform.mjs checks the copies agree.

// The platform to behave as. Tests inject one with TASK_HUB_TEST_PLATFORM (only when
// NODE_ENV=test), e.g. to exercise the POSIX branches of the server on Windows.
export function currentPlatform() {
  return process.env.NODE_ENV === 'test' && process.env.TASK_HUB_TEST_PLATFORM
    ? process.env.TASK_HUB_TEST_PLATFORM
    : process.platform;
}

const TRANSIENT_FILE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Windows: antivirus scanners, search indexers and plain readers may hold a file without
// FILE_SHARE_DELETE, so rename/unlink/open fail for milliseconds with EPERM/EBUSY/EACCES and
// succeed shortly after. POSIX: the same codes are real permission errors, and retrying would
// only delay the failure by about two seconds.
export function isTransientFileError(code, platform = currentPlatform()) {
  return platform === 'win32' && TRANSIENT_FILE_CODES.has(code);
}

// Linking a skill folder: a directory junction on Windows (no admin rights or developer mode
// needed), a plain directory symlink elsewhere.
export const symlinkType = (platform = currentPlatform()) => (platform === 'win32' ? 'junction' : 'dir');

// Removing a link must never touch its target: rmdir removes a junction's reparse point,
// unlink removes a POSIX symlink. (Both fail on a non-empty real directory.)
export const linkRemovalMethod = (platform = currentPlatform()) => (platform === 'win32' ? 'rmdir' : 'unlink');

// Comparing two real paths (both already passed through realpath). NTFS is case-insensitive and
// realpath does not always canonicalise the case there; on macOS realpath returns the on-disk
// case, so an exact comparison is right.
export function pathsEqual(left, right, platform = currentPlatform()) {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// The same machine under a different network name: macOS reports "Mac.local" or "Mac.fritz.box"
// depending on the network, so compare the first label only.
export const shortHostname = (name) => String(name ?? '').trim().toLowerCase().split('.')[0];
export const sameMachine = (left, right) => shortHostname(left) !== '' && shortHostname(left) === shortHostname(right);

// Windows cannot create a file or folder named after a legacy device, with or without an
// extension (CON, nul.txt, COM1.x ...). Task and Run ids become folder names, and repositories
// move between operating systems, so these names are rejected on EVERY platform.
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
export const isWindowsReservedName = (name) => RESERVED_NAME.test(String(name));
export const reservedNameSource = RESERVED_NAME.source;

// Ids that differ only by case name the same folder on case-insensitive file systems (Windows,
// default macOS): they must be unique ignoring case on every platform.
export const idKey = (id) => String(id).trim().toLowerCase();

export const isWindows = (platform = currentPlatform()) => platform === 'win32';
