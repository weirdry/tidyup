import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import caches from '../skills/tidyup/scripts/lib/detectors/caches.mjs';
import { EXIT, main } from '../skills/tidyup/scripts/tidyup.mjs';
import { fakeTools, makeHome, removeTree, runMain, writeFiles } from './helpers/fixtures.mjs';

describe('package caches', () => {
  let home;
  let tools;
  const cleanup = [];
  beforeEach(() => {
    home = makeHome();
    writeFiles(home, {
      '.npm/_cacache/index-v5/entry': 'x'.repeat(8192),
      'Library/pnpm/store/v10/files/blob': 'x'.repeat(8192),
      '.cache/uv/wheels/blob': 'x'.repeat(8192),
      'Library/Caches/go-build/blob': 'x'.repeat(8192),
      'go/pkg/mod/cache/blob': 'x'.repeat(8192),
    });
    tools = fakeTools({
      npm: join(home, '.npm'),
      pnpm: join(home, 'Library/pnpm/store/v10'),
      uv: join(home, '.cache/uv'),
      goCache: join(home, 'Library/Caches/go-build'),
      goModCache: join(home, 'go/pkg/mod'),
    });
    cleanup.push(home, tools.dir);
  });
  after(() => cleanup.forEach(removeTree));

  const scan = async () => JSON.parse((await runMain(main, ['scan', '--json'], { home, percent: 5, tools })).stdout);
  const cacheItems = async () => (await scan()).items.filter((item) => item.detector === 'caches');

  test('each present cache is a routine item located by its tool', async () => {
    const items = await cacheItems();
    assert.deepEqual(items.map((item) => item.kind), ['npm', 'pnpm', 'uv', 'go-build', 'go-mod']);
    assert.ok(items.every((item) => item.class === 'routine' && item.id && item.path === undefined));
    const npm = items.find((item) => item.kind === 'npm');
    assert.equal(npm.evidence.path, join(home, '.npm/_cacache'));
    assert.match(npm.label, /^npm cache \(~\/\.npm\/_cacache\)$/);
    assert.ok(npm.estimated_bytes >= 8192);
  });

  test('pnpm reports the store size as evidence, not as an estimate of what prune frees', async () => {
    const pnpm = (await cacheItems()).find((item) => item.kind === 'pnpm');
    assert.equal(pnpm.estimated_bytes, null);
    assert.ok(pnpm.evidence.cache_bytes >= 8192);
  });

  test('tools run from the home directory, so project-level config does not apply', async () => {
    await cacheItems();
    assert.ok(tools.calls().length > 0);
    assert.ok(tools.calls().every(([, cwd]) => cwd === home), JSON.stringify(tools.calls()));
  });

  test('a cache that does not exist is not listed', async () => {
    tools.update({ uv: join(home, 'missing-uv-cache') });
    assert.equal((await cacheItems()).some((item) => item.kind === 'uv'), false);
  });

  test('apply cleans with the tool command aimed at the located cache, never by deleting it itself', async () => {
    const items = await cacheItems();
    const ids = ['npm', 'go-mod'].map((kind) => items.find((item) => item.kind === kind).id);
    const result = await runMain(main, ['apply', ...ids, '--json'], { home, percent: 5, tools });
    assert.equal(result.code, EXIT.ok, result.stdout + result.stderr);
    const commands = tools.calls().map(([tool, , ...args]) => [tool, ...args].join(' '));
    assert.ok(commands.includes(`npm cache clean --force --cache ${join(home, '.npm')}`), commands.join('\n'));
    assert.ok(commands.includes('go clean -modcache'));
    assert.equal(existsSync(join(home, '.npm/_cacache')), false);
    assert.equal(existsSync(join(home, 'go/pkg/mod')), false);
    assert.equal(existsSync(join(home, '.cache/uv/wheels/blob')), true);
  });

  test('inherited Go flags cannot widen a build-cache clean to the module cache', async () => {
    tools.update({ goEnvFlags: '-modcache' });
    const goBuild = (await cacheItems()).find((item) => item.kind === 'go-build');
    const result = await runMain(main, ['apply', goBuild.id, '--json'], {
      home, percent: 5, tools, env: { GOFLAGS: '-modcache' },
    });
    assert.equal(result.code, EXIT.ok, result.stdout + result.stderr);
    assert.equal(existsSync(join(home, 'Library/Caches/go-build')), false);
    assert.equal(existsSync(join(home, 'go/pkg/mod/cache/blob')), true);
  });

  test('removal refuses when the tool now reports a different location', async () => {
    const npm = (await cacheItems()).find((item) => item.kind === 'npm');
    writeFiles(home, { 'other-npm/_cacache/entry': 'x' });
    tools.update({ npm: join(home, 'other-npm') });
    const context = { env: { HOME: home, PATH: tools.dir }, home, now: new Date() };
    await assert.rejects(caches.remove(npm, context), /cache location changed/);
    assert.equal(existsSync(join(home, 'other-npm/_cacache/entry')), true);
    assert.equal(existsSync(join(home, '.npm/_cacache')), true);
  });

  test('a uv cache under link-mode symlink is a review item with a warning', async () => {
    const fromEnv = JSON.parse((await runMain(main, ['scan', '--json'], { home, percent: 5, tools, env: { UV_LINK_MODE: 'symlink' } })).stdout)
      .items.find((item) => item.kind === 'uv');
    assert.equal(fromEnv.class, 'review');
    assert.match(fromEnv.evidence.warning, /symlink/);

    writeFiles(home, { '.config/uv/uv.toml': 'link-mode = "symlink"\n' });
    const fromConfig = (await cacheItems()).find((item) => item.kind === 'uv');
    assert.equal(fromConfig.class, 'review');

    writeFiles(home, { '.config/uv/uv.toml': '# default\n' });
    const byDefault = (await cacheItems()).find((item) => item.kind === 'uv');
    assert.equal(byDefault.class, 'routine');
    assert.match(byDefault.evidence.link_mode, /clone/);
  });

  test('a cache that cannot be inspected is reported as skipped', async () => {
    const locked = join(home, 'locked');
    mkdirSync(join(locked, 'uv'), { recursive: true });
    tools.update({ uv: join(locked, 'uv') });
    chmodSync(locked, 0o000);
    try {
      const report = await scan();
      assert.equal(report.items.some((item) => item.kind === 'uv'), false);
      assert.ok(report.skipped.some((entry) => /cannot inspect .*locked\/uv: EACCES/.test(entry.reason)), JSON.stringify(report.skipped));
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('apply refuses a cache whose location changed after the scan', async () => {
    const npm = (await cacheItems()).find((item) => item.kind === 'npm');
    writeFiles(home, { 'other-npm/_cacache/entry': 'x' });
    tools.update({ npm: join(home, 'other-npm') });
    const result = await runMain(main, ['apply', npm.id, '--json'], { home, percent: 5, tools });
    assert.equal(result.code, EXIT.error);
    assert.equal(JSON.parse(result.stdout).outcomes[0].outcome, 'refused');
    assert.equal(existsSync(join(home, '.npm/_cacache')), true);
    const commands = tools.calls().map(([tool, , ...args]) => [tool, ...args].join(' '));
    assert.equal(commands.includes('npm cache clean --force'), false);
  });
});
