// Directories that may hold unique work, so they are review items: the user must
// see the evidence and name each ID. Both detectors require the directory to be
// owned by the current user and idle for IDLE_DAYS.
//   temp-clones    top-level entries of temp roots containing a git work tree
//   agent-scratch  Claude Code session directories: <root>/<project>/<session>
// Removal first removes every linked worktree inside through git, re-checks the
// path, then removes the directory.
import { execFile } from 'node:child_process';
import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateBytes, isInside, itemId, mapLimit, modifiedSince, pathRefusal, realpathOrNull } from '../fsutil.mjs';
import { findWorkTrees, gitFacts, hasWorkTreeWithin, removeLinkedWorktrees, summarizeFacts } from '../git.mjs';

export const IDLE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_DEPTH = 3;
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

async function existingRealDirs(paths) {
  const result = [];
  for (const path of paths) {
    const real = await realpathOrNull(path);
    if (real && (await stat(real)).isDirectory() && !result.includes(real)) result.push(real);
  }
  return result;
}

// Default roots; tests and callers may override them through context.paths.
export function agentScratchRoots(context) {
  if (context.paths?.agentScratchRoots) return existingRealDirs(context.paths.agentScratchRoots);
  const name = `claude-${process.getuid()}`;
  return existingRealDirs([join('/private/tmp', name), join(tmpdir(), name)]);
}

export async function tempRoots(context) {
  if (context.paths?.tempRoots) return existingRealDirs(context.paths.tempRoots);
  const home = context.env.HOME ?? context.home;
  return existingRealDirs(['/private/tmp', tmpdir(), join(home, '.codex', 'worktrees')]);
}

// Real, non-symlink subdirectories of `dir` owned by the current user. Failures
// other than absence are pushed to `errors`.
async function ownedSubdirs(dir, errors) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!ABSENT.has(error.code)) errors.push(`cannot read ${dir}: ${error.code ?? error.message}`);
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const stats = await lstat(path).catch(() => null);
    if (stats?.isDirectory() && stats.uid === process.getuid()) result.push(path);
  }
  return result;
}

// Read-only directories (e.g. Go module caches) block deleting their entries, so
// make them owner-writable first (find does not follow symlinks), then remove.
async function removeTree(path) {
  await new Promise((resolve) => {
    execFile('find', [path, '-type', 'd', '!', '-perm', '-u+w', '-exec', 'chmod', 'u+w', '{}', '+'], () => resolve());
  });
  await rm(path, { recursive: true, force: true });
}

// `finalCheck(candidate, context, since)` runs last in evaluation and returns
// `{ reason }` to make the candidate ineligible, or `{ evidence }` to add. It may
// throw when it cannot decide.
function workDirDetector({ name, roots, candidatesIn, finalCheck = async () => ({ evidence: {} }) }) {
  async function evaluate(candidate, context) {
    try {
      const since = new Date(context.now.getTime() - IDLE_DAYS * DAY_MS);
      if (await modifiedSince(candidate.path, since)) return { eligible: false, reason: `modified within ${IDLE_DAYS} days` };
      const trees = await findWorkTrees(candidate.path);
      const facts = await mapLimit(trees, 4, (tree) => gitFacts(tree, context.env));
      const final = await finalCheck(candidate, context, since);
      if (final.reason) return { eligible: false, reason: final.reason };
      const evidence = { idle_days: IDLE_DAYS, git: facts, ...final.evidence };
      evidence.summary = [final.evidence.summary, summarizeFacts(facts)].filter(Boolean).join('; ');
      return { eligible: true, evidence };
    } catch (error) {
      return { eligible: false, reason: error.message, error: true };
    }
  }

  return {
    name,
    roots,

    async discover(context) {
      const candidates = [];
      const errors = [];
      for (const root of await roots(context)) {
        for (const path of await candidatesIn(root, context, errors)) {
          candidates.push({ id: itemId(name, path), class: 'review', detector: name, path });
        }
      }
      return { candidates, skipped: errors.map((reason) => ({ detector: name, reason })) };
    },

    evaluate,

    async detect(context) {
      const { candidates, skipped } = await this.discover(context);
      const items = [];
      await mapLimit(candidates, 4, async (candidate) => {
        const verdict = await evaluate(candidate, context);
        if (verdict.error) skipped.push({ detector: name, reason: verdict.reason });
        if (!verdict.eligible) return;
        let bytes = null;
        try {
          bytes = await estimateBytes(candidate.path);
        } catch (error) {
          skipped.push({ detector: name, reason: error.message });
        }
        items.push({ ...candidate, estimated_bytes: bytes, evidence: verdict.evidence });
      });
      items.sort((a, b) => a.path.localeCompare(b.path));
      return { items, skipped };
    },

    allowedRoots(context) {
      return roots(context);
    },

    async remove(item, context) {
      const stats = await lstat(item.path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('no longer a real directory');
      await removeLinkedWorktrees(item.path, context.env);
      // git removed the item itself when the item root was a linked worktree.
      try {
        await lstat(item.path);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw new Error(`cannot inspect ${item.path} after removing worktrees: ${error.code ?? error.message}`);
      }
      // Worktree removal can take a while; re-check the path right before deleting.
      const refusal = await pathRefusal(item.path, await roots(context));
      if (refusal) throw new Error(refusal);
      await removeTree(item.path);
    },
  };
}

export const tempClones = workDirDetector({
  name: 'temp-clones',
  roots: tempRoots,
  // Top-level entries holding a git work tree; agent scratch roots are left to agent-scratch.
  async candidatesIn(root, context, errors) {
    const scratch = await agentScratchRoots(context);
    const result = [];
    for (const path of await ownedSubdirs(root, errors)) {
      if (scratch.some((dir) => dir === path || isInside(dir, path))) continue;
      if (await hasWorkTreeWithin(path, CANDIDATE_DEPTH, errors)) result.push(path);
    }
    return result;
  },
});

// The session transcript, when Claude Code still has one:
// ~/.claude/projects/<project>/<session>.jsonl. Absence is null; other failures throw.
async function transcriptOf(candidate, context) {
  const home = context.env.HOME ?? context.home;
  const [session, project] = candidate.path.split('/').reverse();
  const path = join(home, '.claude', 'projects', project, `${session}.jsonl`);
  try {
    return { path, modified: (await stat(path)).mtime };
  } catch (error) {
    if (ABSENT.has(error.code)) return null;
    throw new Error(`cannot inspect transcript ${path}: ${error.code ?? error.message}`);
  }
}

export const agentScratch = workDirDetector({
  name: 'agent-scratch',
  roots: agentScratchRoots,
  async candidatesIn(root, context, errors) {
    const sessions = [];
    for (const project of await ownedSubdirs(root, errors)) sessions.push(...(await ownedSubdirs(project, errors)));
    return sessions;
  },
  // Read once, after the git evidence: a transcript written within the idle window
  // means the session may still be in use.
  async finalCheck(candidate, context, since) {
    const transcript = await transcriptOf(candidate, context);
    if (transcript && transcript.modified > since) return { reason: `session transcript modified within ${IDLE_DAYS} days` };
    return {
      evidence: {
        session_owner: 'unknown',
        transcript: transcript ? { path: transcript.path, modified: transcript.modified.toISOString() } : null,
        summary: transcript ? `transcript last modified ${transcript.modified.toISOString().slice(0, 10)}` : 'no transcript found',
      },
    };
  },
});
