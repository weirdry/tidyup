import assert from 'node:assert/strict';
import { chmodSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import rustTarget from '../skills/tidyup/scripts/lib/detectors/rust-target.mjs';
import { age, cargoProject, link, makeHome, removeTree, writeFiles } from './helpers/fixtures.mjs';

describe('rust-target detector', () => {
  let home;
  const homes = [];
  beforeEach(() => {
    home = makeHome();
    homes.push(home);
  });
  after(() => homes.forEach(removeTree));

  const detect = (roots = [join(home, 'code')]) => rustTarget.detect({ roots, now: new Date(), home });

  test('lists an idle Cargo target with its evidence and size', async () => {
    const { target } = cargoProject(home, 'code/app');
    const { items, skipped } = await detect();
    assert.deepEqual(skipped, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].path, target);
    assert.equal(items[0].class, 'routine');
    assert.match(items[0].id, /^rust-target:[0-9a-f]{10}$/);
    assert.equal(items[0].evidence.marker, 'CACHEDIR.TAG');
    assert.ok(items[0].estimated_bytes >= 4096);
  });

  test('accepts a fingerprint directory when CACHEDIR.TAG is absent', async () => {
    cargoProject(home, 'code/maturin-app', { marker: 'fingerprint' });
    const { items } = await detect();
    assert.equal(items.length, 1);
    assert.equal(items[0].evidence.marker, 'fingerprint');
  });

  test('IDs are stable across scans', async () => {
    cargoProject(home, 'code/app');
    const [first] = (await detect()).items;
    const [second] = (await detect()).items;
    assert.equal(first.id, second.id);
  });

  test('a recently modified file anywhere in target keeps it out', async () => {
    const { target } = cargoProject(home, 'code/app');
    const recent = join(target, 'debug', 'build-output.bin');
    utimesSync(recent, new Date(), new Date());
    assert.deepEqual((await detect()).items, []);
  });

  test('a recently modified directory alone keeps it out', async () => {
    const { target } = cargoProject(home, 'code/app');
    utimesSync(join(target, 'debug'), new Date(), new Date());
    assert.deepEqual((await detect()).items, []);
  });

  test('an unreadable directory is reported as skipped, not as an empty result', async () => {
    cargoProject(home, 'code/readable');
    writeFiles(join(home, 'code/locked'), { 'Cargo.toml': '[package]\n' });
    const locked = join(home, 'code/locked');
    chmodSync(locked, 0o000);
    try {
      const { items, skipped } = await detect();
      assert.equal(items.length, 1);
      assert.equal(skipped.length, 1);
      assert.match(skipped[0].reason, /cannot read .*code\/locked: EACCES/);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('targets without a Cargo marker or without Cargo.toml are ignored', async () => {
    cargoProject(home, 'code/no-marker', { marker: null });
    writeFiles(join(home, 'code/not-cargo'), { 'target/CACHEDIR.TAG': 'Signature: 8a477f597d28d172789f06886806bc55\n' });
    age(join(home, 'code'), 30);
    assert.deepEqual((await detect()).items, []);
  });

  test('symlinked targets and targets under node_modules, hidden, or deep directories are ignored', async () => {
    const real = cargoProject(home, 'elsewhere/app');
    writeFiles(join(home, 'code/linked'), { 'Cargo.toml': '[package]\n' });
    link(real.target, join(home, 'code/linked/target'));
    cargoProject(home, 'code/web/node_modules/dep');
    cargoProject(home, 'code/.hidden/app');
    cargoProject(home, 'code/a/b/c/d/deep');
    assert.deepEqual((await detect()).items, []);
  });

  test('finds targets up to four levels below a root', async () => {
    const { target } = cargoProject(home, 'code/a/b/c/app');
    assert.deepEqual((await detect()).items.map((item) => item.path), [target]);
  });
});
