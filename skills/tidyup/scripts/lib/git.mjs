// Read-only git evidence for directories that may hold unique work, and
// git-aware removal of linked worktrees. Every git command runs:
//   - without inherited GIT_* variables, so GIT_DIR or GIT_WORK_TREE cannot
//     redirect it;
//   - with core.fsmonitor disabled, so a repository's configured monitor command
//     never runs during a scan;
//   - for evidence, with --no-optional-locks, so `git status` does not refresh
//     the index (which would make an idle tree look recently modified).
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveTool, runTool } from './tools.mjs';

const SAFE = ['-c', 'core.fsmonitor=false'];
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

function gitEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

// True when a git work tree exists at most `maxDepth` levels below `dir`
// (including `dir`). A cheap, bounded check used to pick candidates; unreadable
// directories (other than vanished ones) are pushed to `errors`.
export async function hasWorkTreeWithin(dir, maxDepth, errors) {
  async function walk(current, depth) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (!ABSENT.has(error.code)) errors.push(`cannot read ${current}: ${error.code ?? error.message}`);
      return false;
    }
    if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) return true;
    if (depth >= maxDepth) return false;
    for (const entry of entries) {
      if (entry.isDirectory() && (await walk(join(current, entry.name), depth + 1))) return true;
    }
    return false;
  }
  return walk(dir, 0);
}

// Every git work tree anywhere under `dir`, nested ones included, without
// following symlinks or descending into .git directories. Paths are NUL-framed,
// so a name containing a newline cannot be misread as another path. Throws when
// part of the tree cannot be read, because then a nested work tree could be missed.
// Whether a tree is a linked worktree is decided by git (see worktreeKind).
export async function findWorkTrees(dir) {
  const stdout = await new Promise((resolve, reject) => {
    execFile('find', [dir, '-name', '.git', '-print0', '-prune'], { maxBuffer: 16 * 1024 * 1024 }, (error, out, err) => {
      if (error) reject(new Error(`cannot search ${dir} for git work trees: ${err.trim().split('\n')[0] || error.message}`));
      else resolve(out);
    });
  });
  const trees = [];
  for (const gitPath of stdout.split('\0').filter(Boolean)) {
    const stats = await lstat(gitPath).catch(() => null);
    if (stats && (stats.isDirectory() || stats.isFile())) trees.push({ path: dirname(gitPath), gitFile: stats.isFile() });
  }
  return trees.sort((a, b) => a.path.localeCompare(b.path));
}

// 'linked' for a linked worktree (its git dir differs from the repository's common
// dir), 'own' for a repository with its own git dir (a clone, or a submodule whose
// .git file points into the superproject), or null when git cannot tell.
// Each directory is queried separately and only the trailing newline is removed,
// so paths containing newlines compare correctly.
async function worktreeKind(bin, path, env) {
  const dirOf = async (flag) =>
    (await runTool(bin, [...SAFE, '-C', path, 'rev-parse', '--path-format=absolute', flag], gitEnv(env))).replace(/\n$/, '');
  try {
    const gitDir = await dirOf('--git-dir');
    const commonDir = await dirOf('--git-common-dir');
    if (!gitDir || !commonDir) return null;
    return gitDir === commonDir ? 'own' : 'linked';
  } catch {
    return null;
  }
}

// Counts of changed (including untracked) and ignored entries in
// `git status --porcelain=v1 -z --ignored=matching` output. A rename or copy in
// either status column carries an extra source path field.
export function countStatus(output) {
  const fields = output.split('\0');
  const counts = { changed: 0, ignored: 0 };
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === '') continue;
    if (field.startsWith('!! ')) counts.ignored += 1;
    else counts.changed += 1;
    if ('RC'.includes(field[0]) || 'RC'.includes(field[1])) i += 1;
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
  if (!bin) return { path: tree.path, linked: false, error: 'git not found' };
  const call = (args) => runTool(bin, ['--no-optional-locks', ...SAFE, '-C', tree.path, ...args], gitEnv(env));
  const count = async (args) => Number((await call(['rev-list', '--count', ...args])).trim());
  const kind = await worktreeKind(bin, tree.path, env);
  if (!kind) return { path: tree.path, linked: false, error: `git cannot read ${tree.path}: fatal: not a usable git work tree` };
  tree = { ...tree, linked: kind === 'linked' };
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

// Removes every linked worktree inside `dir` (deepest first) through git, so their
// repositories keep no stale entries. Without --force, git refuses a worktree
// with changes or untracked files, which stops the whole removal. Repositories
// with their own git dir (clones, submodules) go with the directory. A .git file
// that git cannot classify stops the removal: it might be a linked worktree whose
// changes git would otherwise have protected.
export async function removeLinkedWorktrees(dir, env) {
  const candidates = (await findWorkTrees(dir)).filter((tree) => tree.gitFile);
  if (candidates.length === 0) return;
  const bin = await resolveTool('git', env);
  if (!bin) throw new Error('git not found; cannot remove linked worktrees');
  candidates.sort((a, b) => b.path.length - a.path.length);
  for (const tree of candidates) {
    const kind = await worktreeKind(bin, tree.path, env);
    if (kind === 'own') continue;
    if (kind === null) throw new Error(`cannot tell whether ${tree.path} is a linked worktree; check and remove it manually`);
    await runTool(bin, [...SAFE, '-C', tree.path, 'worktree', 'remove', tree.path], gitEnv(env));
  }
}
