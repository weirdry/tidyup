// Synthetic fixtures for tests. Everything lives under a fresh temporary
// directory; tests never touch the real home directory.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CACHEDIR_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag.\n';

// A temporary "home" directory, resolved through /var → /private/var.
export function makeHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'tidyup-home-')));
}

export function removeTree(path) {
  rmSync(path, { recursive: true, force: true });
}

export function writeFiles(base, files) {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(base, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

// Sets atime/mtime of `path` and everything below it to `days` ago, children first.
export function age(path, days) {
  const time = new Date(Date.now() - days * DAY_MS);
  const stats = lstatSync(path);
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) age(join(path, name), days);
  }
  if (!stats.isSymbolicLink()) utimesSync(path, time, time);
}

// A Cargo project at `home/relative` with a target directory.
// marker: 'tag' (CACHEDIR.TAG), 'fingerprint' (target/debug/.fingerprint), or null.
export function cargoProject(home, relative, { marker = 'tag', idleDays = 30 } = {}) {
  const project = join(home, relative);
  const files = {
    'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    'target/debug/build-output.bin': 'x'.repeat(4096),
  };
  if (marker === 'tag') files['target/CACHEDIR.TAG'] = CACHEDIR_TAG;
  if (marker === 'fingerprint') files['target/debug/.fingerprint/fixture/hash'] = 'fp';
  writeFiles(project, files);
  if (idleDays > 0) age(project, idleDays);
  return { project, target: join(project, 'target') };
}

export function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

// A statfs stand-in reporting `percent` of a 1000-block volume as available.
export function fakeStatfs(percent) {
  return async () => ({ blocks: 1000, bsize: 4096, bavail: Math.round(10 * percent) });
}

// Runs main() with captured output.
export async function runMain(main, argv, { home, percent = 50, ...rest } = {}) {
  const out = { stdout: '', stderr: '' };
  const code = await main(argv, {
    platform: 'darwin',
    stdout: { write: (text) => { out.stdout += text; } },
    stderr: { write: (text) => { out.stderr += text; } },
    env: { HOME: home },
    statfs: fakeStatfs(percent),
    ...rest,
  });
  return { code, ...out };
}
