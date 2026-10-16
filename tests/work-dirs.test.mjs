import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { tempClones } from '../skills/tidyup/scripts/lib/detectors/work-dirs.mjs';
import { countStatus, findWorkTrees } from '../skills/tidyup/scripts/lib/git.mjs';
import { EXIT, main } from '../skills/tidyup/scripts/tidyup.mjs';
import { age, makeHome, removeTree, runMain, writeFiles } from './helpers/fixtures.mjs';

// Fixture git commands. Background maintenance is disabled so that nothing writes
// into a repository after the test has aged its files.
function git(cwd, ...args) {
  const config = ['user.name=t', 'user.email=t@example.com', 'init.defaultBranch=main', 'maintenance.auto=false', 'gc.auto=0'];
  // Inherited GIT_* variables (e.g. GIT_DIR, GIT_INDEX_FILE) could redirect writes outside the fixture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', [...config.flatMap((entry) => ['-c', entry]), ...args], {
    cwd, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository at `dir` with one commit; with `remote`, that commit is pushed.
function repo(dir, { remote } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'file.txt'), 'content\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  if (remote) {
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'main');
  }
}

test('status parsing counts changed and ignored entries, renames once in either column', () => {
  const output = [' M a.txt', '?? new.txt', 'R  b.txt', 'old-b.txt', ' R c.txt', 'old-c.txt', '!! target/', ''].join('\0');
  assert.deepEqual(countStatus(output), { changed: 4, ignored: 1 });
});

describe('temp-clones and agent-scratch', () => {
  let home;
  let tmp;
  let scratch;
  const homes = [];
  beforeEach(() => {
    home = makeHome();
    homes.push(home);
    tmp = join(home, 'tmp');
    scratch = join(tmp, 'claude-test');
    mkdirSync(scratch, { recursive: true });
  });
  after(() => homes.forEach((h) => {
    spawnSync('chmod', ['-R', 'u+w', h]);
    removeTree(h);
  }));

  const paths = () => ({ tempRoots: [tmp], agentScratchRoots: [scratch] });
  const run = (argv, extra = {}) => runMain(main, argv, { home, percent: 5, paths: paths(), ...extra });
  const scanItems = async (extra) => JSON.parse((await run(['scan', '--json'], extra)).stdout).items
    .filter((item) => item.detector === 'temp-clones' || item.detector === 'agent-scratch');
  const byPath = (items, path) => items.find((item) => item.path === path);

  test('an idle clone is a review item with evidence of what removal would lose', async () => {
    repo(join(tmp, 'pushed/app'), { remote: join(home, 'remotes/app.git') });
    repo(join(tmp, 'local-only'));
    writeFileSync(join(tmp, 'local-only/untracked.txt'), 'x');
    git(join(tmp, 'local-only'), 'stash', 'push', '-q', '--include-untracked');
    writeFileSync(join(tmp, 'local-only/file.txt'), 'changed\n');
    age(tmp, 30);

    const items = await scanItems();
    const pushed = byPath(items, join(tmp, 'pushed'));
    assert.equal(pushed.class, 'review');
    assert.deepEqual(
      { changed: pushed.evidence.git[0].changed, only_here: pushed.evidence.git[0].only_here, stashes: pushed.evidence.git[0].stashes },
      { changed: 0, only_here: 0, stashes: 0 },
    );
    const local = byPath(items, join(tmp, 'local-only')).evidence.git[0];
    assert.deepEqual({ changed: local.changed, only_here: local.only_here, stashes: local.stashes }, { changed: 1, only_here: 1, stashes: 1 });
  });

  test('scanning does not refresh the git index, so an idle clone stays idle for apply', async () => {
    repo(join(tmp, 'clone'));
    age(tmp, 30);
    const [item] = await scanItems();
    const applied = await run(['apply', '--reviewed', item.id, '--json']);
    assert.equal(applied.code, EXIT.ok, applied.stdout);
    assert.equal(existsSync(join(tmp, 'clone')), false);
  });

  test('recent, non-git, and symlinked entries are not candidates', async () => {
    repo(join(tmp, 'recent'));
    writeFiles(tmp, { 'plain/file.txt': 'x' });
    repo(join(home, 'elsewhere'));
    symlinkSync(join(home, 'elsewhere'), join(tmp, 'linked'));
    age(join(tmp, 'plain'), 30);
    assert.deepEqual(await scanItems(), []);
  });

  test('a review item needs --reviewed, and the scan shows its evidence', async () => {
    repo(join(tmp, 'clone'));
    age(tmp, 30);
    const human = await run(['scan']);
    assert.match(human.stdout, /Review evidence/);
    assert.match(human.stdout, /temp-clones:[0-9a-f]{10}\s+1 git work tree\(s\), 0 changed, 1 commit\(s\) only here/);

    const [item] = await scanItems();
    const refused = await run(['apply', item.id, '--json']);
    assert.equal(refused.code, EXIT.error);
    assert.match(JSON.parse(refused.stdout).outcomes[0].reason, /requires --reviewed/);
    assert.equal(existsSync(join(tmp, 'clone')), true);
  });

  test('linked worktrees are removed through git; a dirty one stops the removal', async () => {
    const main = join(home, 'repos/main');
    repo(main);
    git(main, 'worktree', 'add', '-q', '--detach', join(tmp, 'task/wt'));
    git(main, 'worktree', 'add', '-q', '--detach', join(tmp, 'dirty/wt'));
    writeFileSync(join(tmp, 'dirty/wt/file.txt'), 'edited\n');
    age(tmp, 30);

    const items = await scanItems();
    const clean = byPath(items, join(tmp, 'task'));
    assert.equal(clean.evidence.git[0].linked, true);
    assert.equal(clean.evidence.git[0].stashes, null);
    const result = JSON.parse((await run(['apply', '--reviewed', clean.id, '--reviewed', byPath(items, join(tmp, 'dirty')).id, '--json'])).stdout);
    assert.deepEqual(result.outcomes.map((o) => o.outcome), ['deleted', 'failed']);
    assert.equal(existsSync(join(tmp, 'task')), false);
    assert.equal(existsSync(join(tmp, 'dirty/wt/file.txt')), true);
    assert.doesNotMatch(git(main, 'worktree', 'list'), /task/);
  });

  test('a detached commit in a linked worktree counts as only here', async () => {
    const main = join(home, 'repos/main');
    repo(main);
    git(main, 'worktree', 'add', '-q', '--detach', join(tmp, 'detached/wt'));
    writeFileSync(join(tmp, 'detached/wt/new.txt'), 'x');
    git(join(tmp, 'detached/wt'), 'add', '.');
    git(join(tmp, 'detached/wt'), 'commit', '-q', '-m', 'only here');
    age(tmp, 30);
    const [item] = await scanItems();
    assert.equal(item.evidence.git[0].only_here, 1);
  });

  test('read-only directories inside an item do not block removal', async () => {
    repo(join(tmp, 'clone'));
    writeFiles(tmp, { 'clone/gomod/pkg@v1/file.go': 'package x\n' });
    chmodSync(join(tmp, 'clone/gomod/pkg@v1'), 0o555);
    age(tmp, 30);
    const [item] = await scanItems();
    const result = await run(['apply', '--reviewed', item.id, '--json']);
    assert.equal(result.code, EXIT.ok, result.stdout);
    assert.equal(existsSync(join(tmp, 'clone')), false);
  });

  test('inherited GIT_DIR cannot redirect the evidence', async () => {
    repo(join(tmp, 'clone'));
    const other = join(home, 'other');
    repo(other);
    writeFileSync(join(other, 'second.txt'), 'x');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'second');
    writeFileSync(join(other, 'file.txt'), 'changed\n');
    age(tmp, 30);
    const [item] = await scanItems({ env: { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other } });
    const facts = item.evidence.git[0];
    assert.equal(facts.error, undefined);
    assert.deepEqual({ changed: facts.changed, only_here: facts.only_here }, { changed: 0, only_here: 1 });
  });

  test('a nested linked worktree is part of the evidence and its changes stop the removal', async () => {
    const mainRepo = join(home, 'repos/main');
    repo(mainRepo);
    repo(join(tmp, 'outer'));
    writeFileSync(join(tmp, 'outer/.gitignore'), 'nested/\n');
    git(join(tmp, 'outer'), 'add', '.gitignore');
    git(join(tmp, 'outer'), 'commit', '-q', '-m', 'ignore nested');
    git(mainRepo, 'worktree', 'add', '-q', '--detach', join(tmp, 'outer/nested'));
    writeFileSync(join(tmp, 'outer/nested/file.txt'), 'unsaved work\n');
    age(tmp, 30);

    const [item] = await scanItems();
    assert.deepEqual(item.evidence.git.map((f) => [f.path.split('/').pop(), f.linked]), [['outer', false], ['nested', true]]);
    const result = JSON.parse((await run(['apply', '--reviewed', item.id, '--json'])).stdout);
    assert.equal(result.outcomes[0].outcome, 'failed');
    assert.equal(existsSync(join(tmp, 'outer/nested/file.txt')), true);
  });

  test('an item that is itself a linked worktree is reported as deleted', async () => {
    const mainRepo = join(home, 'repos/main');
    repo(mainRepo);
    git(mainRepo, 'worktree', 'add', '-q', '--detach', join(tmp, 'wt'));
    age(tmp, 30);
    const [item] = await scanItems();
    const result = JSON.parse((await run(['apply', '--reviewed', item.id, '--json'])).stdout);
    assert.equal(result.outcomes[0].outcome, 'deleted', JSON.stringify(result.outcomes));
    assert.equal(existsSync(join(tmp, 'wt')), false);
    assert.doesNotMatch(git(mainRepo, 'worktree', 'list'), /\/wt /);
  });

  test("a repository's fsmonitor command never runs during a scan", async () => {
    repo(join(tmp, 'clone'));
    const marker = join(home, 'fsmonitor-ran');
    const hook = join(home, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, { mode: 0o755 });
    git(join(tmp, 'clone'), 'config', 'core.fsmonitor', hook);
    age(tmp, 30);
    assert.equal((await scanItems()).length, 1);
    assert.equal(existsSync(marker), false);
  });

  test('unreadable roots, subtrees, and transcripts are reported, not treated as absent', async () => {
    repo(join(tmp, 'clone'));
    mkdirSync(join(tmp, 'clone/private'));
    writeFiles(scratch, { 'project-a/session-a/notes.md': 'x' });
    writeFiles(home, { '.claude/projects/project-a/session-a.jsonl': '{}\n' });
    mkdirSync(join(tmp, 'locked'));
    age(tmp, 30);
    age(join(home, '.claude'), 30);
    for (const dir of [join(tmp, 'clone/private'), join(tmp, 'locked'), join(home, '.claude/projects/project-a')]) chmodSync(dir, 0o000);
    try {
      const report = JSON.parse((await run(['scan', '--json'])).stdout);
      const ours = report.items.filter((item) => item.detector === 'temp-clones' || item.detector === 'agent-scratch');
      assert.deepEqual(ours, []);
      const reasons = report.skipped.map((entry) => entry.reason).join('\n');
      assert.match(reasons, /cannot read .*locked: EACCES/);
      assert.match(reasons, /clone/);
      assert.match(reasons, /cannot inspect transcript .*EACCES/);
    } finally {
      for (const dir of [join(tmp, 'clone/private'), join(tmp, 'locked'), join(home, '.claude/projects/project-a')]) chmodSync(dir, 0o755);
    }
  });

  test('removal re-checks the path after removing linked worktrees', async () => {
    // A fake git whose `worktree remove` also swaps the item for a symlink out of the roots.
    const fakeDir = mkdtempSync(join(tmpdir(), 'tidyup-fake-git-'));
    homes.push(fakeDir);
    const outside = join(home, 'outside');
    writeFiles(outside, { 'precious.txt': 'keep' });
    writeFiles(tmp, { 'task/wt/.git': 'gitdir: /nowhere\n', 'task/wt/file.txt': 'x' });
    writeFileSync(join(fakeDir, 'git'), `#!/bin/sh
case "$*" in
  *--git-common-dir*) echo /repo/.git ;;
  *--git-dir*) echo /repo/.git/worktrees/wt ;;
  *"worktree remove"*)
    /bin/rm -rf '${join(tmp, 'task/wt')}'
    /bin/mv '${join(tmp, 'task')}' '${join(home, 'moved-task')}'
    /bin/ln -s '${outside}' '${join(tmp, 'task')}' ;;
esac
`, { mode: 0o755 });
    const item = { id: 'temp-clones:x', class: 'review', detector: 'temp-clones', path: join(tmp, 'task') };
    const context = { env: { HOME: home, PATH: fakeDir }, home, now: new Date(), paths: paths() };
    await assert.rejects(tempClones.remove(item, context), /symlink/);
    assert.equal(existsSync(join(outside, 'precious.txt')), true);
  });

  test('a path containing a newline cannot be read as a work tree outside the item', async () => {
    const mainRepo = join(home, 'repos/main');
    repo(mainRepo);
    const outsideWt = join(home, 'outside/wt');
    git(mainRepo, 'worktree', 'add', '-q', '--detach', outsideWt);
    // Inside the item, mirror the outside path below a directory whose name ends in a newline.
    const item = join(tmp, 'item');
    writeFiles(join(item, 'x\n', outsideWt), { '.git': 'gitdir: /nowhere\n' });
    const trees = await findWorkTrees(item);
    assert.ok(trees.every((tree) => tree.path.startsWith(item + '/')), JSON.stringify(trees));
  });

  test('a submodule is not treated as a linked worktree', async () => {
    const library = join(home, 'repos/library');
    repo(library);
    repo(join(tmp, 'app'));
    git(join(tmp, 'app'), '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(join(tmp, 'app'), 'commit', '-q', '-m', 'add submodule');
    age(tmp, 30);
    const [item] = await scanItems();
    const submodule = item.evidence.git.find((f) => f.path.endsWith('/lib'));
    assert.equal(submodule.linked, false);
    assert.equal(typeof submodule.stashes, 'number');
    const result = JSON.parse((await run(['apply', '--reviewed', item.id, '--json'])).stdout);
    assert.equal(result.outcomes[0].outcome, 'deleted', JSON.stringify(result.outcomes));
  });

  test('a .git file that git cannot classify stops the removal', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'tidyup-fake-git-'));
    homes.push(fakeDir);
    writeFiles(tmp, { 'task/wt/.git': 'gitdir: /nowhere\n', 'task/wt/work.txt': 'x' });
    writeFileSync(join(fakeDir, 'git'), '#!/bin/sh\necho "fatal: not a git repository" >&2\nexit 128\n', { mode: 0o755 });
    const item = { id: 'temp-clones:x', class: 'review', detector: 'temp-clones', path: join(tmp, 'task') };
    const context = { env: { HOME: home, PATH: fakeDir }, home, now: new Date(), paths: paths() };
    await assert.rejects(tempClones.remove(item, context), /cannot tell whether .* is a linked worktree/);
    assert.equal(existsSync(join(tmp, 'task/wt/work.txt')), true);
  });

  test('linked-worktree classification handles directories whose names contain newlines', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'tidyup-fake-git-'));
    homes.push(fakeDir);
    const log = join(fakeDir, 'calls.log');
    writeFiles(tmp, { 'task/wt/.git': 'gitdir: /x\n' });
    // Answers each flag with a path containing newlines; a combined query would read
    // "/a" twice and wrongly call this worktree "own".
    writeFileSync(join(fakeDir, 'git'), `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  *"--git-dir --git-common-dir"*) printf '/a\\n/a\\n/.git/worktrees/wt\\n/a\\n/a\\n/.git\\n' ;;
  *--git-common-dir*) printf '/a\\n/a\\n/.git\\n' ;;
  *--git-dir*) printf '/a\\n/a\\n/.git/worktrees/wt\\n' ;;
  *"worktree remove"*) /bin/rm -rf '${join(tmp, 'task/wt')}' ;;
esac
`, { mode: 0o755 });
    const item = { id: 'temp-clones:x', class: 'review', detector: 'temp-clones', path: join(tmp, 'task') };
    const context = { env: { HOME: home, PATH: fakeDir }, home, now: new Date(), paths: paths() };
    await tempClones.remove(item, context);
    assert.match(readFileSync(log, 'utf8'), /worktree remove/);
  });

  test('a failure to inspect the item after worktree removal is an error, not success', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'tidyup-fake-git-'));
    homes.push(fakeDir);
    writeFiles(tmp, { 'task/wt/.git': 'gitdir: /nowhere\n' });
    // rev-parse reports a linked worktree; worktree remove deletes it and locks the parent.
    writeFileSync(join(fakeDir, 'git'), `#!/bin/sh
case "$*" in
  *--git-common-dir*) echo /repo/.git ;;
  *--git-dir*) echo /repo/.git/worktrees/wt ;;
  *"worktree remove"*) /bin/rm -rf '${join(tmp, 'task/wt')}'; /bin/chmod 000 '${tmp}' ;;
esac
`, { mode: 0o755 });
    const item = { id: 'temp-clones:x', class: 'review', detector: 'temp-clones', path: join(tmp, 'task') };
    const context = { env: { HOME: home, PATH: fakeDir }, home, now: new Date(), paths: paths() };
    try {
      await assert.rejects(tempClones.remove(item, context), /cannot inspect .* after removing worktrees: EACCES/);
    } finally {
      chmodSync(tmp, 0o755);
    }
    assert.equal(existsSync(join(tmp, 'task')), true);
  });

  test('agent session directories are review items unless their transcript is recent', async () => {
    writeFiles(scratch, {
      'project-a/session-old/scratchpad/notes.md': 'x',
      'project-a/session-live/scratchpad/notes.md': 'x',
      'project-a/session-orphan/tasks/out.txt': 'x',
      'loose-file.json': '{}',
    });
    writeFiles(home, {
      '.claude/projects/project-a/session-old.jsonl': '{}\n',
      '.claude/projects/project-a/session-live.jsonl': '{}\n',
    });
    age(scratch, 30);
    age(join(home, '.claude/projects/project-a/session-old.jsonl'), 30);
    utimesSync(join(home, '.claude/projects/project-a/session-live.jsonl'), new Date(), new Date());

    const items = (await scanItems()).filter((item) => item.detector === 'agent-scratch');
    assert.deepEqual(items.map((item) => item.path.split('/').pop()).sort(), ['session-old', 'session-orphan']);
    assert.match(byPath(items, join(scratch, 'project-a/session-old')).evidence.summary, /transcript last modified/);
    assert.match(byPath(items, join(scratch, 'project-a/session-orphan')).evidence.summary, /no transcript found/);
    assert.equal(byPath(items, join(scratch, 'project-a/session-old')).evidence.session_owner, 'unknown');
  });

  test('agent scratch roots inside a temp root are left to agent-scratch', async () => {
    repo(join(scratch, 'project-a/session-old/scratchpad/clone'));
    age(tmp, 30);
    const items = await scanItems();
    assert.equal(items.some((item) => item.detector === 'temp-clones'), false);
    assert.equal(items.filter((item) => item.detector === 'agent-scratch').length, 1);
  });
});

test('summaries never present unreadable trees as zeros', async () => {
  const { summarizeFacts } = await import('../skills/tidyup/scripts/lib/git.mjs');
  const unreadable = { path: '/x', linked: false, error: 'git -C /x status failed: fatal: not a git repository' };
  assert.equal(summarizeFacts([unreadable]), '1 git work tree(s), unreadable (not a git repository)');
  const readable = { path: '/y', linked: false, changed: 2, ignored: 0, only_here: 1, stashes: 0 };
  assert.match(summarizeFacts([readable, unreadable]), /2 git work tree\(s\), 2 changed, 1 commit\(s\) only here, .*1 unreadable, not counted/);
});
