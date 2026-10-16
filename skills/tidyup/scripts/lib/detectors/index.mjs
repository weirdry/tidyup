// Registered detectors. Each provides:
//   name
//   discover(context)        → { candidates, skipped }: candidates that have IDs
//   evaluate(candidate, ctx) → { eligible, reason, error }: eligibility right now
//   detect(context)          → { items, skipped }: items with class and size estimate (scan)
//   remove(item, context)    → deletes one item (apply)
// Detectors whose items have a filesystem `path` also provide
//   allowedRoots(context)    → real paths (or a promise of them) bounding where items live
// Review items carry `evidence.summary`, a one-line account shown to the user.
// Other items carry a `label` instead of a `path`.
import caches from './caches.mjs';
import docker from './docker.mjs';
import rustTarget from './rust-target.mjs';
import { agentScratch, tempClones } from './work-dirs.mjs';

export const DETECTORS = [rustTarget, docker, caches, tempClones, agentScratch];

export function detectorFor(id) {
  const separator = id.indexOf(':');
  if (separator < 1) return null;
  const name = id.slice(0, separator);
  return DETECTORS.find((detector) => detector.name === name) ?? null;
}
