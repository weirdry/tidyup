import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { removalRefusal } from '../skills/tidyup/scripts/lib/apply.mjs';
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
