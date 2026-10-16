// `scan`: measure headroom and, under pressure or on request, run the detectors.
// Read-only: nothing here deletes or writes.
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { DETECTORS } from './detectors/index.mjs';
import { realpathOrNull } from './fsutil.mjs';
import { measureHeadroom } from './headroom.mjs';

export const DEFAULT_ROOT_NAMES = ['code', 'src', 'Developer', 'projects', '_GIT', 'git', 'work'];

// Real paths of existing project roots: the defaults under `home` plus `extra`.
// An `extra` root that does not exist is an error. Nested roots are kept: the walk
// is depth-limited and skips hidden directories, so an explicit inner root can
// reach projects the outer walk cannot. Detectors deduplicate candidates.
export async function resolveRoots(home, extra = []) {
  const resolved = [];
  for (const name of DEFAULT_ROOT_NAMES) {
    const real = await realpathOrNull(join(home, name));
    if (real && (await stat(real)).isDirectory()) resolved.push(real);
  }
  for (const path of extra) {
    const real = await realpathOrNull(path);
    if (!real || !(await stat(real)).isDirectory()) throw new Error(`root is not a directory: ${path}`);
    resolved.push(real);
  }
  return [...new Set(resolved)];
}

// Runs the given detectors; a failing detector is reported in `skipped`.
export async function runDetectors(detectors, context) {
  const items = [];
  const skipped = [];
  for (const detector of detectors) {
    try {
      const result = await detector.detect(context);
      items.push(...result.items);
      skipped.push(...result.skipped);
    } catch (error) {
      skipped.push({ detector: detector.name, reason: error.message });
    }
  }
  return { items, skipped };
}

export function fingerprint(items) {
  const ids = items.filter((item) => item.id).map((item) => item.id).sort();
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16);
}

export async function scan({ home, roots, deep, now, statfs, env, paths }) {
  const headroom = await measureHeadroom(home, statfs);
  const measure = deep || headroom.level !== 'ok';
  const { items, skipped } = measure
    ? await runDetectors(DETECTORS, { roots, now, home, env, paths })
    : { items: [], skipped: [] };
  return {
    host: hostname(),
    ...headroom,
    candidates_measured: measure,
    items,
    skipped,
    fingerprint: fingerprint(items),
  };
}
