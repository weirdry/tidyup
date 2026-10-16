// Read-only git evidence for directories that may hold unique work, and
// git-aware removal of linked worktrees. Inherited GIT_* variables are dropped
// so that GIT_DIR or GIT_WORK_TREE can never redirect a command elsewhere, and
// evidence commands run with --no-optional-locks so `git status` does not
// refresh the index (which would make an idle tree look recently modified).
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveTool, runTool } from './tools.mjs';

const SKIP_DIRS = new Set(['node_modules']);

function gitEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

// Git work trees at most `maxDepth` levels below `dir` (including `dir` itself),
// without following symlinks or descending into a found work tree.
// `linked` is true when `.git` is a file (a linked worktree or similar).
export async function findWorkTrees(dir, maxDepth = 3) {
  const trees = [];
  async function walk(current, depth) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    const dotGit = entries.find((entry) => entry.name === '.git');
    if (dotGit && (dotGit.isDirectory() || dotGit.isFile())) {
      trees.push({ path: current, linked: dotGit.isFile() });
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walk(join(current, entry.name), depth + 1);
    }
  }
  await walk(dir, 0);
  return trees;
}

// Counts of changed (including untracked) and ignored entries in
// `git status --porcelain=v1 -z --ignored=matching` output. Renames and copies
// carry an extra path field.
export function countStatus(output) {
  const fields = output.split('\0');
  const counts = { changed: 0, ignored: 0 };
  for (let i = 0; i < fields.length; i += 1) {
    if (fields[i] === '') continue;
    if (fields[i].startsWith('!! ')) counts.ignored += 1;
    else counts.changed += 1;
    if (fields[i][0] === 'R' || fields[i][0] === 'C') i += 1;
  }
  return counts;
}

// Facts about one work tree, or `{ error }` when git cannot read it (for example
// a repository owned by another user, which git refuses by default).
// `only_here` counts commits that removing the tree would lose:
//   - standalone clone: commits on HEAD, branches or tags that no remote-tracking ref has;
//   - linked worktree: commits on its HEAD that no branch, tag or remote has (branches
//     live in the shared repository and survive). Its stashes are shared too, so
//     `stashes` is null.
export async function gitFacts(tree, env) {
  const bin = await resolveTool('git', env);
  if (!bin) return { path: tree.path, linked: tree.linked, error: 'git not found' };
  const call = (args) => runTool(bin, ['--no-optional-locks', '-C', tree.path, ...args], gitEnv(env));
  const count = async (args) => Number((await call(['rev-list', '--count', ...args])).trim());
  try {
    const { changed, ignored } = countStatus(
      await call(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching']),
    );
    const hasHead = await call(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
    let onlyHere;
    if (tree.linked) {
      onlyHere = hasHead ? await count(['HEAD', '--not', '--branches', '--tags', '--remotes']) : 0;
    } else {
      onlyHere = await count([...(hasHead ? ['HEAD'] : []), '--branches', '--tags', '--not', '--remotes']);
    }
    const stashes = tree.linked ? null : (await call(['stash', 'list'])).split('\n').filter((line) => line.trim() !== '').length;
    return { path: tree.path, linked: tree.linked, changed, ignored, only_here: onlyHere, stashes };
  } catch (error) {
    return { path: tree.path, linked: tree.linked, error: error.message };
  }
}

// One line for the user. Counts cover readable trees only; unreadable ones are
// named as such, never shown as zeros.
export function summarizeFacts(facts) {
  if (facts.length === 0) return 'no git work trees';
  const readable = facts.filter((f) => !f.error);
  const unreadable = facts.length - readable.length;
  const firstError = facts.find((f) => f.error)?.error.split('\n').find((line) => line.includes('fatal')) ?? 'git failed';
  if (readable.length === 0) return `${facts.length} git work tree(s), unreadable (${firstError.replace(/^.*?fatal: /, '')})`;
  const sum = (key) => readable.reduce((total, f) => total + (f[key] ?? 0), 0);
  const parts = [
    `${facts.length} git work tree(s)`,
    `${sum('changed')} changed`,
    `${sum('only_here')} commit(s) only here`,
    `${sum('stashes')} stash(es)`,
    `${sum('ignored')} ignored`,
  ];
  if (readable.some((f) => f.linked)) parts.push(`${readable.filter((f) => f.linked).length} linked`);
  if (unreadable > 0) parts.push(`${unreadable} unreadable, not counted`);
  return parts.join(', ');
}

// Removes the linked worktrees inside `dir` through git, so their repositories
// do not keep stale entries. Without --force, git refuses worktrees with changes.
export async function removeLinkedWorktrees(dir, env) {
  const linked = (await findWorkTrees(dir)).filter((tree) => tree.linked);
  if (linked.length === 0) return;
  const bin = await resolveTool('git', env);
  if (!bin) throw new Error('git not found; cannot remove linked worktrees');
  for (const tree of linked) {
    const stats = await lstat(join(tree.path, '.git'));
    if (!stats.isFile()) continue;
    await runTool(bin, ['-C', tree.path, 'worktree', 'remove', tree.path], gitEnv(env));
  }
}
