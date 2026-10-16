import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { EXIT, main } from '../skills/tidyup/scripts/tidyup.mjs';
import { cargoProject, makeHome, removeTree, runMain } from './helpers/fixtures.mjs';

const launcher = join(import.meta.dirname, '..', 'skills', 'tidyup', 'scripts', 'tidyup');

describe('arguments', () => {
  test('--help prints usage and succeeds', async () => {
    const result = await runMain(main, ['--help'], { home: '/unused' });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /^Usage:/);
  });

  test('missing, unknown, or malformed input is a usage error', async () => {
    const cases = [[], ['bogus'], ['--nope'], ['scan', 'some-id'], ['apply'], ['apply', 'x:1', '--deep']];
    for (const argv of cases) {
      const result = await runMain(main, argv, { home: '/unused' });
      assert.equal(result.code, EXIT.usage, `argv: ${JSON.stringify(argv)}`);
      assert.match(result.stderr, /Usage:/);
    }
  });

  test('non-macOS platforms are refused before anything else', async () => {
    const result = await runMain(main, ['--help'], { home: '/unused', platform: 'linux' });
    assert.equal(result.code, EXIT.error);
    assert.match(result.stderr, /macOS only/);
  });
});

describe('scan and apply', () => {
  let home;
  const homes = [];
  beforeEach(() => {
    home = makeHome();
    homes.push(home);
  });
  after(() => homes.forEach(removeTree));

  async function scanJson(argv = [], options = {}) {
    const result = await runMain(main, ['scan', '--json', ...argv], { home, ...options });
    return { ...result, report: JSON.parse(result.stdout) };
  }

  test('at ok headroom, scan skips measurement unless --deep', async () => {
    cargoProject(home, 'code/app');
    const plain = await scanJson([], { percent: 50 });
    assert.equal(plain.code, EXIT.ok);
    assert.equal(plain.report.candidates_measured, false);
    assert.deepEqual(plain.report.items, []);

    const deep = await scanJson(['--deep'], { percent: 50 });
    assert.equal(deep.code, EXIT.ok);
    assert.equal(deep.report.candidates_measured, true);
    assert.equal(deep.report.items.length, 1);
  });

  test('scan exit codes follow the headroom level', async () => {
    assert.equal((await scanJson([], { percent: 15 })).code, EXIT.recommend);
    assert.equal((await scanJson([], { percent: 5 })).code, EXIT.urgent);
  });

  test('scan reports a deterministic fingerprint of eligible IDs', async () => {
    cargoProject(home, 'code/a');
    cargoProject(home, 'code/b');
    const first = (await scanJson([], { percent: 5 })).report;
    const second = (await scanJson([], { percent: 5 })).report;
    assert.equal(first.items.length, 2);
    assert.equal(first.fingerprint, second.fingerprint);
  });

  test('--root adds a project root outside the default locations', async () => {
    const { target } = cargoProject(home, 'elsewhere/app');
    const without = (await scanJson([], { percent: 5 })).report;
    assert.deepEqual(without.items, []);
    const withRoot = (await scanJson(['--root', join(home, 'elsewhere')], { percent: 5 })).report;
    assert.deepEqual(withRoot.items.map((item) => item.path), [target]);
  });

  test('human output lists candidates with home-relative paths', async () => {
    cargoProject(home, 'code/app');
    const result = await runMain(main, ['scan'], { home, percent: 5 });
    assert.equal(result.code, EXIT.urgent);
    assert.match(result.stdout, /URGENT/);
    assert.match(result.stdout, /rust-target:[0-9a-f]{10}\s+routine\s+.*~\/code\/app\/target/);
  });

  test('apply deletes only the selected item', async () => {
    const keep = cargoProject(home, 'code/keep');
    const drop = cargoProject(home, 'code/drop');
    const { items } = (await scanJson([], { percent: 5 })).report;
    const id = items.find((item) => item.path === drop.target).id;

    const result = await runMain(main, ['apply', id, '--json'], { home, percent: 5 });
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).outcomes, [{ id, path: drop.target, outcome: 'deleted' }]);
    assert.equal(existsSync(drop.target), false);
    assert.equal(existsSync(keep.target), true);
    assert.equal(existsSync(join(drop.project, 'Cargo.toml')), true);
  });

  test('apply refuses an item that became active after the scan', async () => {
    const { target } = cargoProject(home, 'code/app');
    const [item] = (await scanJson([], { percent: 5 })).report.items;
    utimesSync(join(target, 'debug', 'build-output.bin'), new Date(), new Date());

    const result = await runMain(main, ['apply', item.id, '--json'], { home, percent: 5 });
    assert.equal(result.code, EXIT.error);
    assert.equal(JSON.parse(result.stdout).outcomes[0].outcome, 'refused');
    assert.equal(existsSync(target), true);
  });

  test('apply refuses unknown IDs and IDs outside the given roots', async () => {
    const { target } = cargoProject(home, 'elsewhere/app');
    const [item] = (await scanJson(['--root', join(home, 'elsewhere')], { percent: 5 })).report.items;

    const result = await runMain(main, ['apply', item.id, 'rust-target:0000000000', 'nope:1', '--json'], { home, percent: 5 });
    assert.equal(result.code, EXIT.error);
    const outcomes = JSON.parse(result.stdout).outcomes;
    assert.deepEqual(outcomes.map((o) => o.outcome), ['refused', 'refused', 'refused']);
    assert.match(outcomes[0].reason, /same --root/);
    assert.match(outcomes[2].reason, /unknown detector/);
    assert.equal(existsSync(target), true);
  });
});

describe('launcher', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const fixtures = makeHome();
  after(() => removeTree(fixtures));

  function launch(args, env) {
    return spawnSync('sh', [launcher, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  }

  test('runs tidyup.mjs with the resolved Node', () => {
    const result = launch(['--help'], { TIDYUP_NODE: process.execPath });
    assert.equal(result.status, EXIT.ok, result.stderr);
    assert.match(result.stdout, /^Usage:/);
  });

  test('an invalid TIDYUP_NODE fails instead of falling through', () => {
    const result = launch(['--help'], { TIDYUP_NODE: join(fixtures, 'missing-node') });
    assert.equal(result.status, EXIT.error);
    assert.match(result.stderr, /TIDYUP_NODE=.* is not a Node\.js 22\+ executable/);
  });

  test('a Node older than 22 is rejected', () => {
    const oldNode = join(fixtures, 'node20');
    writeFileSync(oldNode, '#!/bin/sh\necho 20\n');
    chmodSync(oldNode, 0o755);
    const result = launch(['--help'], { TIDYUP_NODE: oldNode });
    assert.equal(result.status, EXIT.error);
    assert.match(result.stderr, /not a Node\.js 22\+ executable/);
  });
});
