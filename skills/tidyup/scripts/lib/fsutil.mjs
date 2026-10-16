// Filesystem helpers shared by detectors. Heavy traversal is delegated to the
// native `du` and `find` tools; operands are always absolute paths so that
// names starting with '-' are never parsed as options.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

function run(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: { ...process.env, LC_ALL: 'C' }, timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

function requireAbsolute(path) {
  if (!isAbsolute(path)) throw new Error(`expected an absolute path: ${path}`);
}

// Estimated allocated size in bytes (du -sk). APFS clones and hard links shared
// with other trees are counted here too, so sums across items overestimate.
export async function estimateBytes(path) {
  requireAbsolute(path);
  const { error, stdout, stderr } = await run('du', ['-sk', path]);
  const kib = Number.parseInt(stdout, 10);
  if (error || !Number.isFinite(kib)) {
    throw new Error(`du failed for ${path}: ${firstLine(stderr) || error?.message}`);
  }
  return kib * 1024;
}

// True when any entry in the tree (including directories) was modified after
// `since`. Throws when the whole tree could not be read, because an unreadable
// subtree cannot prove inactivity.
export async function modifiedSince(path, since) {
  requireAbsolute(path);
  const { error, stdout, stderr } = await run('find', [path, '-newermt', localTimestamp(since), '-print', '-quit']);
  if (stdout.trim() !== '') return true;
  if (error) throw new Error(`could not read all of ${path}: ${firstLine(stderr) || error.message}`);
  return false;
}

// True when `child` is strictly inside `parent`; both must already be real paths.
export function isInside(child, parent) {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export async function realpathOrNull(path) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export function itemId(detector, key) {
  return `${detector}:${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function displayPath(path, home) {
  if (home && path === home) return '~';
  return home && isInside(path, home) ? `~${path.slice(home.length)}` : path;
}

// Runs `fn` over `items` with at most `limit` calls in flight, preserving order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function localTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function firstLine(text) {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}
