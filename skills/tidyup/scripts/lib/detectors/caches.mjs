// Package manager caches. Every one regenerates by downloading again, so they are
// routine. Each is cleaned with the tool's own command; tidyup never deletes a
// tool's cache directory itself. Caches are located by asking the tool, run from
// the home directory so that the global (not a project's) configuration applies.
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { displayPath, estimateBytes, itemId, mapLimit, realpathOrNull } from '../fsutil.mjs';
import { resolveTool, runTool } from '../tools.mjs';

const NAME = 'caches';

const firstLine = (text) => text.split('\n')[0].trim();

// kind: the tool, how to find its cache directory, what to measure, and how to clean it.
// `reclaim: 'unknown'` marks commands that remove only part of the cache, with no
// dry run to say how much; their size is shown as evidence instead of an estimate.
export const CACHES = [
  {
    kind: 'npm',
    tool: 'npm',
    locations: () => [dirname(process.execPath)],
    locate: async (call) => [join(firstLine(await call(['config', 'get', 'cache'])), '_cacache')],
    label: 'npm cache',
    clean: ['cache', 'clean', '--force'],
  },
  {
    kind: 'pnpm',
    tool: 'pnpm',
    locations: (home) => [join(home, 'Library', 'pnpm')],
    locate: async (call) => [firstLine(await call(['store', 'path']))],
    label: 'pnpm store (prune removes unreferenced packages)',
    clean: ['store', 'prune'],
    reclaim: 'unknown',
  },
  {
    kind: 'uv',
    tool: 'uv',
    locations: (home) => [join(home, '.cargo', 'bin')],
    locate: async (call) => [firstLine(await call(['cache', 'dir']))],
    label: 'uv cache',
    clean: ['cache', 'clean'],
  },
  {
    kind: 'go-build',
    tool: 'go',
    locations: () => ['/usr/local/go/bin'],
    locate: async (call) => [firstLine(await call(['env', 'GOCACHE']))],
    label: 'Go build cache',
    clean: ['clean', '-cache'],
  },
  {
    kind: 'go-mod',
    tool: 'go',
    locations: () => ['/usr/local/go/bin'],
    locate: async (call) => [firstLine(await call(['env', 'GOMODCACHE']))],
    label: 'Go module cache',
    clean: ['clean', '-modcache'],
  },
];

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

// The cache directory for `spec` and a runner for its tool, or null when the tool
// is not installed or the cache does not exist.
async function locate(spec, context) {
  const home = context.env.HOME ?? context.home;
  const bin = await resolveTool(spec.tool, context.env, { locations: spec.locations(home) });
  if (!bin) return null;
  const call = (args) => runTool(bin, args, context.env, { cwd: home });
  const [path] = await spec.locate(call);
  if (!path || !(await isDirectory(path))) return null;
  return { call, path: (await realpathOrNull(path)) ?? path };
}

function candidateFor(spec, path, home) {
  return {
    id: itemId(NAME, `${spec.kind}\n${path}`),
    class: 'routine',
    detector: NAME,
    kind: spec.kind,
    label: `${spec.label} (${displayPath(path, home)})`,
    evidence: { path, command: `${spec.tool} ${spec.clean.join(' ')}` },
  };
}

export default {
  name: NAME,

  async discover(context) {
    const candidates = [];
    const skipped = [];
    for (const spec of CACHES) {
      try {
        const found = await locate(spec, context);
        if (found) candidates.push(candidateFor(spec, found.path, context.home));
      } catch (error) {
        skipped.push({ detector: NAME, reason: error.message });
      }
    }
    return { candidates, skipped };
  },

  async evaluate(candidate, context) {
    try {
      const spec = CACHES.find((entry) => entry.kind === candidate.kind);
      const found = spec && (await locate(spec, context));
      if (!found) return { eligible: false, reason: 'tool or cache no longer present' };
      if (found.path !== candidate.evidence.path) return { eligible: false, reason: 'cache location changed' };
      return { eligible: true };
    } catch (error) {
      return { eligible: false, reason: error.message, error: true };
    }
  },

  async detect(context) {
    const { candidates, skipped } = await this.discover(context);
    const items = await mapLimit(candidates, 4, async (candidate) => {
      const spec = CACHES.find((entry) => entry.kind === candidate.kind);
      let bytes = null;
      try {
        bytes = await estimateBytes(candidate.evidence.path);
      } catch (error) {
        skipped.push({ detector: NAME, reason: error.message });
      }
      return spec.reclaim === 'unknown'
        ? { ...candidate, estimated_bytes: null, evidence: { ...candidate.evidence, cache_bytes: bytes } }
        : { ...candidate, estimated_bytes: bytes };
    });
    return { items, skipped };
  },

  async remove(item, context) {
    const spec = CACHES.find((entry) => entry.kind === item.kind);
    const found = await locate(spec, context);
    if (!found) throw new Error('tool or cache no longer present');
    await found.call(spec.clean);
  },
};
