// `apply`: delete user-selected items after re-running their detectors.
// An item is deleted only if a fresh detection still yields the same ID, its
// class allows it, its real path is inside the detector's roots, and it is not a symlink.
import { lstat } from 'node:fs/promises';

import { detectorFor } from './detectors/index.mjs';
import { isInside, realpathOrNull } from './fsutil.mjs';
import { measureHeadroom } from './headroom.mjs';
import { runDetectors } from './scan.mjs';

// Why `item.path` must not be removed now, or null. Detection only yields real
// paths inside the roots; this re-check guards against changes since detection.
export async function removalRefusal(item, allowedRoots) {
  const stats = await lstat(item.path).catch(() => null);
  if (!stats) return 'path no longer exists';
  if (stats.isSymbolicLink()) return 'path is a symlink';
  const real = await realpathOrNull(item.path);
  if (!real || !allowedRoots.some((root) => isInside(real, root))) return 'path is outside the detector roots';
  return null;
}

export async function apply({ ids, reviewed, home, roots, now, statfs }) {
  const before = await measureHeadroom(home, statfs);
  const requested = [...new Set([...ids, ...reviewed])];
  const reviewedSet = new Set(reviewed);

  const detectors = [...new Set(requested.map(detectorFor).filter(Boolean))];
  // Sizes are not needed to decide eligibility, and du over large trees is slow.
  const context = { roots, now, home, estimate: false };
  const { items, skipped } = await runDetectors(detectors, context);
  const byId = new Map(items.map((item) => [item.id, item]));

  const outcomes = [];
  for (const id of requested) {
    const item = byId.get(id);
    if (!detectorFor(id)) {
      outcomes.push({ id, outcome: 'refused', reason: 'unknown detector' });
    } else if (!item) {
      outcomes.push({ id, outcome: 'refused', reason: 'not found or no longer eligible (pass the same --root options as scan)' });
    } else if (item.class === 'review' && !reviewedSet.has(id)) {
      outcomes.push({ id, path: item.path, outcome: 'refused', reason: 'review item requires --reviewed' });
    } else if (item.class !== 'routine' && item.class !== 'review') {
      outcomes.push({ id, path: item.path, outcome: 'refused', reason: `${item.class} items cannot be applied` });
    } else {
      const reason = await removalRefusal(item, detectorFor(id).allowedRoots(context));
      if (reason) {
        outcomes.push({ id, path: item.path, outcome: 'refused', reason });
        continue;
      }
      try {
        await detectorFor(id).remove(item);
        outcomes.push({ id, path: item.path, outcome: 'deleted' });
      } catch (error) {
        outcomes.push({ id, path: item.path, outcome: 'failed', reason: error.message });
      }
    }
  }

  const after = await measureHeadroom(home, statfs);
  return { outcomes, skipped, before, after };
}
