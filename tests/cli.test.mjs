import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { EXIT, main } from '../skills/tidyup/scripts/tidyup.mjs';

const launcher = join(import.meta.dirname, '..', 'skills', 'tidyup', 'scripts', 'tidyup');

function run(argv, options = {}) {
  const out = { stdout: '', stderr: '' };
  const code = main(argv, {
    platform: 'darwin',
    stdout: { write: (text) => { out.stdout += text; } },
    stderr: { write: (text) => { out.stderr += text; } },
    ...options,
  });
  return { code, ...out };
}

describe('tidyup.mjs', () => {
  test('--help prints usage and succeeds', () => {
    const result = run(['--help']);
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /^Usage: tidyup/);
  });

  test('missing, unknown, or malformed input is a usage error', () => {
    for (const argv of [[], ['bogus'], ['--nope']]) {
      const result = run(argv);
      assert.equal(result.code, EXIT.usage, `argv: ${JSON.stringify(argv)}`);
      assert.match(result.stderr, /Usage: tidyup/);
    }
  });

  test('non-macOS platforms are refused before anything else', () => {
    const result = run(['--help'], { platform: 'linux' });
    assert.equal(result.code, EXIT.error);
    assert.match(result.stderr, /macOS only/);
  });

  test('scan and apply report that they are not implemented', () => {
    for (const command of ['scan', 'apply']) {
      const result = run([command]);
      assert.equal(result.code, EXIT.error);
      assert.match(result.stderr, /not implemented/);
    }
  });
});

describe('launcher', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'tidyup-test-'));
  after(() => rmSync(fixtures, { recursive: true, force: true }));

  function launch(args, env) {
    return spawnSync('sh', [launcher, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  }

  test('runs tidyup.mjs with the resolved Node', () => {
    const result = launch(['--help'], { TIDYUP_NODE: process.execPath });
    assert.equal(result.status, EXIT.ok, result.stderr);
    assert.match(result.stdout, /^Usage: tidyup/);
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
