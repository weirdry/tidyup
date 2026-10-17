import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import {
  LEFTOVER_MIN_BYTES, UNIDENTIFIED_MIN_BYTES, expandPath, huggingFaceHub, installedBundleIds, isInstalled, leftoverContainers, parseBrewFree,
} from '../skills/tidyup/scripts/lib/detectors/judgment.mjs';
import { EXIT, main } from '../skills/tidyup/scripts/tidyup.mjs';
import { fakeTools, makeHome, removeTree, runMain, writeFiles } from './helpers/fixtures.mjs';

const GiB = 1024 ** 3;

describe('judgment helpers', () => {
  test('brew dry-run output is parsed with decimal units, as Homebrew formats it', () => {
    assert.equal(parseBrewFree('==> This operation would free approximately 1.5GB of disk space.'), 1_500_000_000);
    assert.equal(parseBrewFree('==> This operation would free approximately 34.6MB of disk space.'), 34_600_000);
    assert.equal(parseBrewFree('nothing to clean'), null);
  });

  test('Hugging Face path settings expand ~ and environment references', () => {
    assert.equal(expandPath('~/models', {}, '/home/u'), '/home/u/models');
    assert.equal(expandPath('$DATA/hf', { DATA: '/data' }, '/home/u'), '/data/hf');
    assert.equal(expandPath('${DATA}/hf', { DATA: '/data' }, '/home/u'), '/data/hf');
    assert.equal(huggingFaceHub({ HF_HOME: '~/hf' }, '/home/u'), '/home/u/hf/hub');
  });

  test('the Hugging Face hub location follows HF_HUB_CACHE, HF_HOME, then XDG', () => {
    assert.equal(huggingFaceHub({ HF_HUB_CACHE: '/hub' }, '/home'), '/hub');
    assert.equal(huggingFaceHub({ HF_HOME: '/hf' }, '/home'), '/hf/hub');
    assert.equal(huggingFaceHub({ XDG_CACHE_HOME: '/xdg' }, '/home'), '/xdg/huggingface/hub');
    assert.equal(huggingFaceHub({}, '/home'), '/home/.cache/huggingface/hub');
  });

  test('an app counts as installed for its own and its extensions\' containers', () => {
    const installed = new Set(['ai.perplexity.mac', 'com.aone.keka']);
    assert.equal(isInstalled('ai.perplexity.mac', installed), true);
    assert.equal(isInstalled('ai.perplexity.mac.askwidget', installed), true);
    assert.equal(isInstalled('com.aone.Keka-Sparkle.Downloader', installed), true);
    assert.equal(isInstalled('com.kurogame.game', installed), false);
  });

  test('only large leftovers of uninstalled apps and very large unidentified containers are listed', () => {
    const sizes = new Map([
      ['/c/com.apple.Safari', 50 * GiB],
      ['/c/com.installed.app', 5 * GiB],
      ['/c/com.removed.small', LEFTOVER_MIN_BYTES - 1],
      ['/c/com.removed.game', 40 * GiB],
      ['/c/A529EAD6-8DD3-413D-94AA-610F11F3875F', 17 * GiB],
      ['/c/2AFCA86A-5528-4BFA-A1EA-C275853195FE', UNIDENTIFIED_MIN_BYTES - 1],
    ]);
    const found = leftoverContainers(sizes, new Set(['com.installed.app']));
    assert.deepEqual(found.map((entry) => [entry.id, entry.identified]), [
      ['com.removed.game', true],
      ['A529EAD6-8DD3-413D-94AA-610F11F3875F', false],
    ]);
  });
});

describe('judgment detectors through the CLI', () => {
  let home;
  let tools;
  const cleanup = [];
  beforeEach(() => {
    home = makeHome();
    tools = fakeTools();
    cleanup.push(home, tools.dir);
  });
  after(() => cleanup.forEach(removeTree));

  const scan = async (extra = {}) => JSON.parse((await runMain(main, ['scan', '--json'], { home, percent: 5, tools, ...extra })).stdout);
  const judgment = (report, detector) => report.items.filter((item) => item.detector === detector);

  test('the Hugging Face cache is one judgment item listing its largest models', async () => {
    writeFiles(home, {
      '.cache/huggingface/hub/models--org--big/blobs/a': 'x'.repeat(64 * 1024),
      '.cache/huggingface/hub/models--org--small/blobs/a': 'x'.repeat(4096),
      '.cache/huggingface/hub/.locks/x': '',
    });
    const [item] = judgment(await scan(), 'model-caches');
    assert.equal(item.class, 'judgment');
    assert.equal(item.id, undefined);
    assert.deepEqual(item.evidence.largest.map((m) => m.name), ['org/big', 'org/small']);
    assert.match(item.label, /2 models/);

    const human = await runMain(main, ['scan'], { home, percent: 5, tools });
    assert.match(human.stdout, /Judgment items .*\n.*Hugging Face model cache .*: largest: org\/big.*\n\s+hint: huggingface-cli delete-cache/);
  });

  test('a model cache that cannot be read is reported, not silently missing', async () => {
    writeFiles(home, { '.cache/huggingface/hub/models--org--m/blobs/a': 'x' });
    const hubParent = join(home, '.cache/huggingface');
    chmodSync(hubParent, 0o000);
    try {
      const report = await scan();
      assert.deepEqual(judgment(report, 'model-caches'), []);
      assert.ok(report.skipped.some((entry) => entry.detector === 'model-caches' && /EACCES/.test(entry.reason)), JSON.stringify(report.skipped));
    } finally {
      chmodSync(hubParent, 0o755);
    }
  });

  test('HF_HUB_CACHE moves the model cache', async () => {
    writeFiles(home, { 'models/hub/models--org--m/blobs/a': 'x' });
    const items = judgment(await scan({ env: { HF_HUB_CACHE: join(home, 'models/hub') } }), 'model-caches');
    assert.equal(items.length, 1);
  });

  test('brew cleanup is a judgment item sized by its dry run, absent when nothing would be freed', async () => {
    tools.update({ brewDryRun: 'Would remove: /x (1 file, 1KB)\n==> This operation would free approximately 1.5GB of disk space.\n' });
    const [item] = judgment(await scan(), 'homebrew');
    assert.equal(item.estimated_bytes, 1_500_000_000);
    assert.match(item.evidence.summary, /old installed formula versions/);

    tools.update({ brewDryRun: '' });
    assert.deepEqual(judgment(await scan(), 'homebrew'), []);
  });

  // Each Spotlight gap skips app-containers with its own reason, lists no
  // leftovers, and leaves the rest of the scan and its exit code unchanged.
  const spotlightGap = async () => {
    writeFiles(home, {
      'Library/Containers/com.removed.app/Data/file': 'x',
      '.cache/huggingface/hub/models--org--m/blobs/a': 'x',
    });
    const result = await runMain(main, ['scan', '--json'], { home, percent: 5, tools });
    assert.equal(result.code, EXIT.urgent);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(judgment(report, 'app-containers'), []);
    assert.equal(judgment(report, 'model-caches').length, 1);
    const entries = report.skipped.filter((entry) => entry.detector === 'app-containers');
    assert.equal(entries.length, 1, JSON.stringify(report.skipped));
    assert.deepEqual(Object.keys(entries[0]), ['detector', 'reason']);
    assert.doesNotMatch(entries[0].reason, /disabled|permission|unavailable/i);
    return entries[0].reason;
  };

  test('a Spotlight result without Finder is reported as incomplete', async () => {
    tools.update({ apps: [] });
    assert.equal(
      await spotlightGap(),
      'the Spotlight query for installed apps returned 0 bundle identifier(s) but not com.apple.finder; the result looks incomplete, '
        + 'so installed apps cannot be identified and leftover containers are not listed (`mdutil -s /` shows the Spotlight indexing status)',
    );
    tools.update({ apps: [['/Applications/Synthetic.app', 'com.example.synthetic']] });
    assert.match(await spotlightGap(), /returned 1 bundle identifier\(s\) but not com\.apple\.finder/);
  });

  test('a failed Spotlight query is reported with the command\'s exit code and output', async () => {
    tools.update({ failures: { mdfind: { stdout: 'synthetic partial output\n', stderr: 'synthetic query failure\n', code: 2 } } });
    assert.equal(
      await spotlightGap(),
      'the Spotlight query for installed apps failed, so installed apps cannot be identified and leftover containers are not listed: '
        + 'mdfind -attr kMDItemCFBundleIdentifier kMDItemContentType == \'com.apple.application-bundle\' failed (exit code 2): '
        + 'synthetic query failure; stdout: synthetic partial output',
    );
  });

  test('a missing mdfind is reported as such', async () => {
    // /usr/bin/mdfind exists on macOS, so the resolved path is passed in directly.
    assert.deepEqual(await installedBundleIds(null, { HOME: home, PATH: tools.dir }), {
      reason: 'mdfind (the Spotlight command-line tool) was not found, so installed apps cannot be identified and leftover containers are not listed',
    });
    assert.deepEqual(tools.calls(), []);
  });

  test('judgment items cannot be applied', async () => {
    const result = await runMain(main, ['apply', 'model-caches:0123456789', '--json'], { home, percent: 5, tools });
    assert.equal(result.code, EXIT.error);
    assert.equal(JSON.parse(result.stdout).outcomes[0].outcome, 'refused');
  });
});
