import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { findCutoff, modifiedSince } from '../skills/tidyup/scripts/lib/fsutil.mjs';
import { makeHome, removeTree, writeFiles } from './helpers/fixtures.mjs';

const HOUR_MS = 60 * 60 * 1000;

test('find cutoffs are UTC, so the repeated DST hour stays unambiguous', () => {
  // 01:30 local time occurs twice in New York on 2026-11-01; in UTC these differ.
  const first = new Date('2026-11-01T05:30:00Z');
  const second = new Date('2026-11-01T06:30:00Z');
  assert.equal(findCutoff(first), '2026-11-01 05:30:00');
  assert.equal(findCutoff(second), '2026-11-01 06:30:00');
});

test('modifiedSince compares against the exact cutoff instant', async () => {
  const home = makeHome();
  after(() => removeTree(home));
  writeFiles(home, { 'tree/file': 'x' });
  const tree = join(home, 'tree');
  const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
  utimesSync(join(tree, 'file'), twoHoursAgo, twoHoursAgo);
  utimesSync(tree, twoHoursAgo, twoHoursAgo);

  // A local/UTC mix-up shifts the cutoff by the UTC offset and flips one of these.
  assert.equal(await modifiedSince(tree, new Date(Date.now() - 3 * HOUR_MS)), true);
  assert.equal(await modifiedSince(tree, new Date(Date.now() - 1 * HOUR_MS)), false);
});
