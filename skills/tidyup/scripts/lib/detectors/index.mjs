// Registered detectors. Each provides:
//   name, class
//   discover(context)        → { candidates, skipped }: cheap candidate locations
//   evaluate(candidate, ctx) → { eligible, reason, evidence, error }: eligibility now
//   detect(context)          → { items, skipped }: eligible items with size estimates (scan)
//   allowedRoots(context)    → real paths that bound where items may live
//   remove(item)             → deletes one item (apply)
import rustTarget from './rust-target.mjs';

export const DETECTORS = [rustTarget];

export function detectorFor(id) {
  const separator = id.indexOf(':');
  if (separator < 1) return null;
  const name = id.slice(0, separator);
  return DETECTORS.find((detector) => detector.name === name) ?? null;
}
