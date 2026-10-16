// Rust build output: a `target/` directory next to a `Cargo.toml` that carries a
// Cargo marker and has been idle for IDLE_DAYS. Removal deletes the directory;
// the next build recreates it.
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { estimateBytes, itemId, mapLimit, modifiedSince } from '../fsutil.mjs';

export const IDLE_DAYS = 14;
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', 'target']);
// Cache Directory Tagging Specification signature, written by Cargo.
const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

async function entriesOf(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Directories under `root` (depth ≤ MAX_DEPTH) holding Cargo.toml and a real
// (non-symlink) target directory. Hidden directories, node_modules and target
// directories are not descended into.
export async function findCargoTargets(root) {
  const found = [];
  async function walk(dir, depth) {
    const entries = await entriesOf(dir);
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
  return found;
}

// 'CACHEDIR.TAG' or 'fingerprint' when the directory looks like Cargo output, else null.
// Some front ends (e.g. maturin) skip the tag, but every Cargo profile directory
// holds a .fingerprint directory.
export async function cargoMarker(target) {
  try {
    const tag = await readFile(join(target, 'CACHEDIR.TAG'), 'utf8');
    if (tag.startsWith(CACHEDIR_SIGNATURE)) return 'CACHEDIR.TAG';
  } catch {
    // No tag; fall through to the fingerprint check.
  }
  for (const entry of await entriesOf(target)) {
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
  name: 'rust-target',
  class: 'routine',

  async detect({ roots, now, estimate = true }) {
    const since = new Date(now.getTime() - IDLE_DAYS * 24 * 60 * 60 * 1000);
    const seen = new Set();
    const candidates = [];
    for (const root of roots) {
      for (const found of await findCargoTargets(root)) {
        if (seen.has(found.target)) continue;
        seen.add(found.target);
        candidates.push(found);
      }
    }

    const items = [];
    const skipped = [];
    await mapLimit(candidates, 4, async ({ project, target }) => {
      const marker = await cargoMarker(target);
      if (!marker) return;
      try {
        if (await modifiedSince(target, since)) return;
      } catch (error) {
        skipped.push({ detector: 'rust-target', reason: error.message });
        return;
      }
      let bytes = null;
      if (estimate) {
        try {
          bytes = await estimateBytes(target);
        } catch (error) {
          skipped.push({ detector: 'rust-target', reason: error.message });
        }
      }
      items.push({
        id: itemId('rust-target', target),
        class: 'routine',
        detector: 'rust-target',
        path: target,
        estimated_bytes: bytes,
        evidence: { manifest: join(project, 'Cargo.toml'), marker, idle_days: IDLE_DAYS },
      });
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
