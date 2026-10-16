// Registered detectors. Each has `name`, `class`, `detect(context)` returning
// `{ items, skipped }` (sizes only when `context.estimate` is not false), `allowedRoots(context)` bounding where its items may
// live, and `remove(item)` for classes that can be applied.
import rustTarget from './rust-target.mjs';

export const DETECTORS = [rustTarget];

export function detectorFor(id) {
  const separator = id.indexOf(':');
  if (separator < 1) return null;
  const name = id.slice(0, separator);
  return DETECTORS.find((detector) => detector.name === name) ?? null;
}
