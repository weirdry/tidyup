import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { runTool } from '../skills/tidyup/scripts/lib/tools.mjs';
import { removeTree } from './helpers/fixtures.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tidyup-cli-'));
after(() => removeTree(dir));

// A synthetic CLI named `fake` that runs `body` with the running Node.
let count = 0;
function fakeCli(body) {
  const sub = join(dir, String((count += 1)));
  const bin = join(sub, 'fake');
  mkdirSync(sub);
  writeFileSync(bin, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return bin;
}

const env = { HOME: dir, PATH: '/usr/bin:/bin' };
const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  assert.fail('expected the run to fail');
};

describe('runTool', () => {
  test('a successful run resolves with stdout unchanged', async () => {
    const bin = fakeCli('process.stdout.write("first\\n  second  \\n"); process.stderr.write("noise\\n");');
    assert.equal(await runTool(bin, ['store', 'path'], env), 'first\n  second  \n');
  });

  test('a failure that prints only to stdout keeps that output and the exit code', async () => {
    const bin = fakeCli('console.log(" ERR_PNPM_SYNTHETIC  Synthetic failure\\n\\nSynthetic detail"); process.exitCode = 1;');
    assert.equal(
      await failure(runTool(bin, ['store', 'path'], env)),
      'fake store path failed (exit code 1): stdout: ERR_PNPM_SYNTHETIC  Synthetic failure | Synthetic detail',
    );
  });

  test('a failure reports stderr first, then stdout, or that there was no output', async () => {
    const both = fakeCli('console.error("warn line\\nerror line"); console.log("out line"); process.exitCode = 2;');
    assert.equal(await failure(runTool(both, ['x'], env)), 'fake x failed (exit code 2): warn line | error line; stdout: out line');
    const silent = fakeCli('process.exitCode = 3;');
    assert.equal(await failure(runTool(silent, [], env)), 'fake failed (exit code 3): no output');
  });

  test('a signal, a timeout, and a spawn error are named', async () => {
    const killed = fakeCli('process.kill(process.pid, "SIGKILL");');
    assert.equal(await failure(runTool(killed, [], env)), 'fake failed (signal SIGKILL): no output');
    const slow = fakeCli('console.log("started"); setTimeout(() => {}, 30000);');
    assert.equal(await failure(runTool(slow, [], env, { timeoutMs: 300 })), 'fake failed (timed out after 0.3s, signal SIGTERM): stdout: started');
    const message = await failure(runTool(join(dir, 'missing', 'fake'), ['a'], env));
    assert.equal(message, 'fake a failed (ENOENT): no output');
  });

  test('likely credentials in output, arguments, and sensitive environment values are masked', async () => {
    const secrets = {
      env: 'synthetic-env-secret-0001',
      url: 'synthetic-url-pass-0002',
      basic: 'c3ludGhldGljOnBhc3M=',
      bearer: 'synthetic.bearer.0003',
      npmrc: 'synthetic-npmrc-0004',
      github: `ghp_${'A'.repeat(36)}`,
      flag: 'synthetic-flag-0005',
      inline: 'synthetic-inline-0006',
      argUrl: 'synthetic-arg-url-0007',
    };
    const bin = fakeCli(`
      console.error("using ${secrets.env} for https://user:${secrets.url}@registry.example.test/pkg");
      console.error("Authorization: Basic ${secrets.basic} then Bearer ${secrets.bearer}");
      console.log("//registry.example.test/:_authToken=${secrets.npmrc} ${secrets.github}");
      process.exitCode = 1;
    `);
    const message = await failure(runTool(
      bin,
      ['--token', secrets.flag, `--password=${secrets.inline}`, `https://${secrets.argUrl}@example.test/x`],
      { ...env, SYNTHETIC_API_TOKEN: secrets.env, VISIBLE_SETTING: 'registry.example.test' },
    ));
    for (const [kind, secret] of Object.entries(secrets)) assert.ok(!message.includes(secret), `${kind} leaked: ${message}`);
    assert.equal(
      message,
      'fake --token *** --password=*** https://***@example.test/x failed (exit code 1): '
        + 'using *** for https://***@registry.example.test/pkg | Authorization: Basic *** then Bearer ***; '
        + 'stdout: //registry.example.test/:_authToken=*** ***',
    );
  });

  test('quoted values of sensitive keys are masked up to their closing quote', async () => {
    const bin = fakeCli('process.stderr.write(process.env.FIXTURE_OUTPUT); process.exitCode = 7;');
    const cases = [
      ['{"password":"synthetic-quoted-secret"}', '{"password":"***"}'],
      ['{"token": "synthetic spaced secret", "user":"visible"}', '{"token": "***", "user":"visible"}'],
      ['{"apiKey":"synthetic-api-0001"}', '{"apiKey":"***"}'],
      ['{"authorization":"Bearer synthetic auth 0002"}', '{"authorization":"***"}'],
      [JSON.stringify({ password: 'synthetic "escaped" secret' }), '{"password":"***"}'],
      [JSON.stringify(JSON.stringify({ token: 'synthetic nested secret' })), '"{\\"token\\":\\"***\\"}"'],
      ["{'password': 'synthetic single secret'}", "{'password': '***'}"],
      ['password="synthetic bare-key secret"', 'password="***"'],
    ];
    for (const [output, shown] of cases) {
      const message = await failure(runTool(bin, [], { ...env, FIXTURE_OUTPUT: output }));
      assert.equal(message, `fake failed (exit code 7): ${shown}`);
    }
  });

  test('a long quoted value is masked whole, with or without its closing quote', async () => {
    const bin = fakeCli('process.stderr.write(process.env.FIXTURE_OUTPUT); process.exitCode = 7;');
    const long = 'A'.repeat(1100);
    const tail = 'synthetic-long-tail-secret';
    const cases = [
      [JSON.stringify({ token: long + tail }), '{"token":"***"}'],
      [JSON.stringify({ password: '\\"x'.repeat(600) + tail, user: 'visible' }), '{"password":"***","user":"visible"}'],
      [JSON.stringify(JSON.stringify({ token: long + tail })), '"{\\"token\\":\\"***\\"}"'],
      [`{"token": "${long}${tail}`, '{"token": "***'],
      [`{"token": "${'\\\\'.repeat(600)}\\"${tail}`, '{"token": "***'],
      [`password='${long}\n${tail}\nnext line`, "password='***"],
      [`password='${long}\n${tail}' done\nnext line`, "password='***' done | next line"],
    ];
    for (const [output, shown] of cases) {
      const message = await failure(runTool(bin, [], { ...env, FIXTURE_OUTPUT: output }));
      assert.ok(!message.includes(tail), `suffix leaked: ${message}`);
      assert.equal(message, `fake failed (exit code 7): ${shown}`);
    }
  });

  test('masking stays fast on many long or unterminated quoted values', async () => {
    const bin = fakeCli('process.stderr.write(process.env.FIXTURE_OUTPUT); process.exitCode = 7;');
    const outputs = [
      `"token":"${'\\\\'.repeat(50)}`.repeat(600),
      'token:"'.repeat(9000),
      `${'x'.repeat(60)}token":"`.repeat(800),
      `{"token": "${'A\\'.repeat(40000)}`,
    ];
    for (const output of outputs) {
      const started = Date.now();
      const message = await failure(runTool(bin, [], { ...env, FIXTURE_OUTPUT: output }));
      assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
      assert.ok(message.length < 500, `${message.length} characters`);
    }
  });

  test('escape sequences are removed before masking, in output and arguments', async () => {
    const token = 'synthetic-styled-secret';
    const raw = 'synthetic\x1b[0m-raw-secret';
    const bin = fakeCli(`
      const { SAMPLE_TOKEN: token, SAMPLE_RAW_TOKEN: raw } = process.env;
      console.error(token.slice(0, 8) + "\\x1b[31m" + token.slice(8));
      console.error(raw + " ghp_" + "A".repeat(18) + "\\x1b[1m" + "A".repeat(18));
      console.error("pass\\x1b[1mword=synthetic-styled-pair");
      process.exitCode = 7;
    `);
    const message = await failure(runTool(
      bin,
      [`${token.slice(0, 4)}\x1b[32m${token.slice(4)}`],
      { ...env, SAMPLE_TOKEN: token, SAMPLE_RAW_TOKEN: raw },
    ));
    assert.equal(message, 'fake *** failed (exit code 7): *** | *** *** | password=***');
  });

  test('values of sensitive arguments are masked when the tool echoes them without a label', async () => {
    const bin = fakeCli('console.error(process.argv[3], process.argv[4].split("=")[1]); process.exitCode = 1;');
    const message = await failure(runTool(bin, ['--token', 'synthetic-arg-token-0001', '--password=synthetic arg pass'], env));
    assert.equal(message, 'fake --token *** --password=*** failed (exit code 1): *** ***');
  });

  test('each line of a multi-line sensitive environment value is masked', async () => {
    const key = '-----BEGIN SYNTHETIC KEY-----\nc3ludGhldGljLWtleS1saW5l\n-----END SYNTHETIC KEY-----';
    const bin = fakeCli('console.error(process.env.SYNTHETIC_PRIVATE_KEY.split("\\n").join("\\n  ")); process.exitCode = 1;');
    const message = await failure(runTool(bin, [], { ...env, SYNTHETIC_PRIVATE_KEY: key }));
    assert.equal(message, 'fake failed (exit code 1): *** | *** | ***');
  });

  test('a sensitive environment value cut at the inspected-output limit is masked, not shown in part', async (t) => {
    // Output is inspected up to 64 KiB per stream. Messages are not printed on
    // failure, so the values stay out of the test output.
    const limit = 64 * 1024;
    const prefix = 'synthetic-cut-value-';
    const long = `${prefix}${'Q'.repeat(70000)}-synthetic-cut-end`;
    const short = `${prefix}${'R'.repeat(1000)}-synthetic-cut-end`;
    const bin = fakeCli('process[process.env.FIXTURE_STREAM].write(process.env.FIXTURE_OUTPUT); process.exitCode = 1;');
    const cases = [
      ['longer than the limit, from the start of stdout', 'stdout', long, long, 'stdout: ***'],
      ['longer than the limit, from the start of stderr', 'stderr', long, long, '***'],
      ['starting before the limit, after blank lines', 'stdout', short, `${'\n'.repeat(limit - 100)}${short}`, 'stdout: ***'],
      ['starting before the limit, after spaces', 'stderr', short, `${' '.repeat(limit - 100)}${short}`, '***'],
      ['split by an escape sequence', 'stderr', short, `${' '.repeat(limit - 100)}${short.slice(0, 40)}\x1b[1m${short.slice(40)}`, '***'],
      ['cut inside an escape sequence', 'stderr', short, `${' '.repeat(limit - 100)}${short.slice(0, 98)}\x1b[31m${short.slice(98)}`, '***'],
    ];
    for (const [name, stream, value, output, shown] of cases) {
      await t.test(name, async () => {
        const message = await failure(runTool(bin, [], { ...env, SYNTHETIC_API_TOKEN: value, FIXTURE_STREAM: stream, FIXTURE_OUTPUT: output }));
        assert.ok(!message.includes(prefix.slice(0, 9)), `value prefix shown in a ${message.length}-character message`);
        assert.ok(!/QQQQ|RRRR/.test(message), `value body shown in a ${message.length}-character message`);
        assert.ok(message.length < 500, `${message.length} characters`);
        assert.ok(message === `fake failed (exit code 1): ${shown}`, `unexpected ${message.length}-character message`);
      });
    }
  });

  test('output is one bounded line with escape sequences removed and control characters escaped', async () => {
    const bin = fakeCli(`
      console.error("\\x1b[31mred\\x1b[0m bell\\x07 bidi\\u202e end");
      console.error("ab.".repeat(40000));
      console.error("third");
      console.error("fourth line is not shown");
      process.exitCode = 1;
    `);
    const message = await failure(runTool(bin, ['line\nbreak'], env));
    assert.ok(message.startsWith('fake line\\u000abreak failed (exit code 1): red bell\\u0007 bidi\\u202e end | ab.ab.'), message);
    assert.ok(message.endsWith('…'), message);
    assert.ok(message.length < 500, `${message.length} characters`);
    assert.doesNotMatch(message, /[\p{Cc}\p{Cf}]/u);
    assert.doesNotMatch(message, /fourth/);
  });
});
