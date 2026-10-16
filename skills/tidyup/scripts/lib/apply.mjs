// `apply`: delete user-selected items. Candidates are re-discovered, then each
// requested item is checked and, only if it still qualifies, removed right away,
// so no other item's checks run between an item's eligibility check and its removal.
import { lstat } from 'node:fs/promises';

import { detectorFor } from './detectors/index.mjs';
import { isInside, realpathOrNull } from './fsutil.mjs';
import { measureHeadroom } from './headroom.mjs';

// Why `item.path` must not be removed now, or null. Discovery only yields real
// paths inside the roots; this re-check guards against changes since then.
export async function removalRefusal(item, allowedRoots) {
  const stats = await lstat(item.path).catch(() => null);
  if (!stats) return 'path no longer exists';
  if (stats.isSymbolicLink()) return 'path is a symlink';
  const real = await realpathOrNull(item.path);
  if (!real || !allowedRoots.some((root) => isInside(real, root))) return 'path is outside the detector roots';
  return null;
}

// Outcome for one requested ID. The path check runs before evaluation (clear
// refusals, no needless traversal) and again after it, immediately before
// removal, because evaluation can take minutes and the path may change meanwhile.
export async function applyItem(id, { detector, candidate, reviewedSet, context }) {
  if (!detector) return { id, outcome: 'refused', reason: 'unknown detector' };
  if (!candidate) return { id, outcome: 'refused', reason: 'not found (pass the same --root options as scan)' };
  const base = candidate.path === undefined ? { id, label: candidate.label } : { id, path: candidate.path };
  const pathCheck = () => (candidate.path === undefined ? null : removalRefusal(candidate, detector.allowedRoots(context)));
  if (candidate.class === 'review' && !reviewedSet.has(id)) {
    return { ...base, outcome: 'refused', reason: 'review item requires --reviewed' };
  }
  if (candidate.class !== 'routine' && candidate.class !== 'review') {
    return { ...base, outcome: 'refused', reason: `${candidate.class} items cannot be applied` };
  }
  const pathReason = await pathCheck();
  if (pathReason) return { ...base, outcome: 'refused', reason: pathReason };
  const verdict = await detector.evaluate(candidate, context);
  if (!verdict.eligible) return { ...base, outcome: 'refused', reason: `no longer eligible: ${verdict.reason}` };
  const lateReason = await pathCheck();
  if (lateReason) return { ...base, outcome: 'refused', reason: lateReason };
  try {
    await detector.remove(candidate, context);
    return { ...base, outcome: 'deleted' };
  } catch (error) {
    return { ...base, outcome: 'failed', reason: error.message };
  }
}

export async function apply({ ids, reviewed, home, roots, now, statfs, env }) {
  const before = await measureHeadroom(home, statfs);
  const requested = [...new Set([...ids, ...reviewed])];
  const reviewedSet = new Set(reviewed);
  const context = { roots, now, home, env };

  const candidates = new Map();
  const skipped = [];
  for (const detector of new Set(requested.map(detectorFor).filter(Boolean))) {
    try {
      const result = await detector.discover(context);
      for (const candidate of result.candidates) candidates.set(candidate.id, candidate);
      skipped.push(...result.skipped);
    } catch (error) {
      skipped.push({ detector: detector.name, reason: error.message });
    }
  }

  const outcomes = [];
  for (const id of requested) {
    outcomes.push(await applyItem(id, { detector: detectorFor(id), candidate: candidates.get(id), reviewedSet, context }));
  }

  const after = await measureHeadroom(home, statfs);
  return { outcomes, skipped, before, after };
}
