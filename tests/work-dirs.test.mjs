import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { countStatus } from '../skills/tidyup/scripts/lib/git.mjs';
import { EXIT, main } from '../skills/tidyup/scripts/tidyup.mjs';
import { age, makeHome, removeTree, runMain, writeFiles } from './helpers/fixtures.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
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

test('status parsing counts changed and ignored entries, renames once', () => {
  const output = [' M a.txt', '?? new.txt', 'R  b.txt', 'old-b.txt', '!! target/', ''].join('\0');
  assert.deepEqual(countStatus(output), { changed: 3, ignored: 1 });
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
