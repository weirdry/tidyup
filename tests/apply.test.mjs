import assert from 'node:assert/strict';
import { existsSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { applyItem, removalRefusal } from '../skills/tidyup/scripts/lib/apply.mjs';
import { link, makeHome, removeTree, writeFiles } from './helpers/fixtures.mjs';

describe('removal re-check', () => {
  const home = makeHome();
  after(() => removeTree(home));
  const root = join(home, 'code');
  writeFiles(home, { 'code/app/target/file': 'x', 'outside/app/target/file': 'x' });
  link(join(home, 'outside'), join(root, 'swapped'));
  link(join(home, 'outside/app/target'), join(root, 'app/linked-target'));

  test('allows a real directory inside a root', async () => {
    assert.equal(await removalRefusal({ path: join(root, 'app/target') }, [root]), null);
  });

  test('refuses a path that no longer exists', async () => {
    assert.match(await removalRefusal({ path: join(root, 'gone/target') }, [root]), /no longer exists/);
  });

  test('refuses a path that is itself a symlink', async () => {
    assert.match(await removalRefusal({ path: join(root, 'app/linked-target') }, [root]), /symlink/);
  });

  test('refuses a path that resolves outside the roots through a symlinked parent', async () => {
    assert.match(await removalRefusal({ path: join(root, 'swapped/app/target') }, [root]), /outside the detector roots/);
  });
});

describe('applyItem', () => {
  const home = makeHome();
  after(() => removeTree(home));
  const root = join(home, 'code');

  test('re-checks the path after evaluation, so a parent swapped meanwhile is refused', async () => {
    writeFiles(home, { 'code/app/target/file': 'x', 'outside/app/target/file': 'x' });
    const candidate = { id: 'fake:1', class: 'routine', path: join(root, 'app/target') };
    let removed = false;
    const detector = {
      allowedRoots: () => [root],
      // Simulates a long evaluation during which the parent becomes a symlink out of the roots.
      evaluate: async () => {
        renameSync(join(root, 'app'), join(home, 'moved-app'));
        symlinkSync(join(home, 'outside/app'), join(root, 'app'));
        return { eligible: true };
      },
      remove: async () => { removed = true; },
    };

    const outcome = await applyItem('fake:1', { detector, candidate, reviewedSet: new Set(), context: {} });
    assert.equal(outcome.outcome, 'refused');
    assert.match(outcome.reason, /outside the detector roots/);
    assert.equal(removed, false);
    assert.equal(existsSync(join(home, 'outside/app/target/file')), true);
  });
});
