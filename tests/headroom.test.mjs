import assert from 'node:assert/strict';
import { test } from 'node:test';

import { levelFor, measureHeadroom } from '../skills/tidyup/scripts/lib/headroom.mjs';
import { fakeStatfs } from './helpers/fixtures.mjs';

test('levels use inclusive 20% and 10% boundaries', () => {
  assert.equal(levelFor(50), 'ok');
  assert.equal(levelFor(20.1), 'ok');
  assert.equal(levelFor(20), 'recommend');
  assert.equal(levelFor(10.1), 'recommend');
  assert.equal(levelFor(10), 'urgent');
  assert.equal(levelFor(0), 'urgent');
});

test('headroom uses unprivileged available blocks over total blocks', async () => {
  const headroom = await measureHeadroom('/fixture', fakeStatfs(15));
  assert.deepEqual(headroom, {
    measured_path: '/fixture',
    total_bytes: 1000 * 4096,
    available_bytes: 150 * 4096,
    available_percent: 15,
    level: 'recommend',
  });
});
