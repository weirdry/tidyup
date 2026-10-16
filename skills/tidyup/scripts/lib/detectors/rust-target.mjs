// Rust build output: a `target/` directory next to a `Cargo.toml` that carries a
// Cargo marker and has been idle for IDLE_DAYS. Removal deletes the directory;
// the next build recreates it.
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { estimateBytes, itemId, mapLimit, modifiedSince } from '../fsutil.mjs';

export const IDLE_DAYS = 14;
const NAME = 'rust-target';
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', 'target']);
// Cache Directory Tagging Specification signature, written by Cargo.
const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';
// A directory that vanished or is not a directory is simply absent; anything
// else (EACCES, EPERM from TCC, ...) is a coverage gap worth reporting.
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

// Directories under `root` (depth ≤ MAX_DEPTH) holding Cargo.toml and a real
// (non-symlink) target directory. Hidden directories, node_modules and target
// directories are not descended into. Unreadable directories are returned in `errors`.
export async function findCargoTargets(root) {
  const found = [];
  const errors = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (!ABSENT.has(error.code)) errors.push(`cannot read ${dir}: ${error.code ?? error.message}`);
      return;
    }
    if (entries.some((e) => e.name === 'Cargo.toml' && e.isFile())) {
      if (entries.some((e) => e.name === 'target' && e.isDirectory())) {
        found.push({ project: dir, target: join(dir, 'target') });
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  }
  await walk(root, 0);
  return { found, errors };
}

// 'CACHEDIR.TAG' or 'fingerprint' when the directory looks like Cargo output, else null.
// Some front ends (e.g. maturin) skip the tag, but every Cargo profile directory
// holds a .fingerprint directory. Throws when the target itself cannot be read.
export async function cargoMarker(target) {
  try {
    const tag = await readFile(join(target, 'CACHEDIR.TAG'), 'utf8');
    if (tag.startsWith(CACHEDIR_SIGNATURE)) return 'CACHEDIR.TAG';
  } catch (error) {
    if (!ABSENT.has(error.code)) throw error;
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      if ((await lstat(join(target, entry.name, '.fingerprint'))).isDirectory()) return 'fingerprint';
    } catch {
      // Not a profile directory.
    }
  }
  return null;
}

export default {
  name: NAME,

  // Candidate locations, without eligibility checks. Cheap: a bounded directory walk.
  async discover({ roots }) {
    const candidates = new Map();
    const skipped = [];
    for (const root of roots) {
      const { found, errors } = await findCargoTargets(root);
      for (const reason of errors) skipped.push({ detector: NAME, reason });
      for (const { project, target } of found) {
        const id = itemId(NAME, target);
        if (!candidates.has(id)) candidates.set(id, { id, class: 'routine', detector: NAME, path: target, project });
      }
    }
    return { candidates: [...candidates.values()], skipped };
  },

  // Whether a candidate qualifies now. `error` is set when eligibility could not be determined.
  async evaluate(candidate, { now }) {
    const since = new Date(now.getTime() - IDLE_DAYS * 24 * 60 * 60 * 1000);
    try {
      const marker = await cargoMarker(candidate.path);
      if (!marker) return { eligible: false, reason: 'no Cargo marker' };
      if (await modifiedSince(candidate.path, since)) return { eligible: false, reason: `modified within ${IDLE_DAYS} days` };
      return { eligible: true, evidence: { manifest: join(candidate.project, 'Cargo.toml'), marker, idle_days: IDLE_DAYS } };
    } catch (error) {
      return { eligible: false, reason: error.message, error: true };
    }
  },

  async detect(context) {
    const { candidates, skipped } = await this.discover(context);
    const items = [];
    await mapLimit(candidates, 4, async (candidate) => {
      const verdict = await this.evaluate(candidate, context);
      if (verdict.error) skipped.push({ detector: NAME, reason: verdict.reason });
      if (!verdict.eligible) return;
      let bytes = null;
      try {
        bytes = await estimateBytes(candidate.path);
      } catch (error) {
        skipped.push({ detector: NAME, reason: error.message });
      }
      const { project, ...item } = candidate;
      items.push({ ...item, estimated_bytes: bytes, evidence: verdict.evidence });
    });
    items.sort((a, b) => a.path.localeCompare(b.path));
    return { items, skipped };
  },

  allowedRoots({ roots }) {
    return roots;
  },

  async remove(item) {
    const stats = await lstat(item.path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('no longer a real directory');
    await rm(item.path, { recursive: true });
  },
};
