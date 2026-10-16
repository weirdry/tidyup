// Package manager caches. Every one regenerates by downloading again, so they are
// routine. Each is cleaned with the tool's own command, aimed explicitly at the
// cache that was located; tidyup never deletes a tool's cache directory itself.
// Caches are located by asking the tool, run from the home directory so that the
// global (not a project's) configuration applies.
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { displayPath, estimateBytes, itemId, mapLimit, realpathOrNull } from '../fsutil.mjs';
import { resolveTool, runTool } from '../tools.mjs';

const NAME = 'caches';

const firstLine = (text) => text.split('\n')[0].trim();

// kind: the tool, how to find its cache directory, and how to clean exactly that
// directory: `clean(path)` returns the arguments and any environment overrides.
// `reclaim: 'unknown'` marks commands that remove only part of the cache, with no
// dry run to say how much; their size is shown as evidence instead of an estimate.
// Go: GOENV=off and an empty GOFLAGS stop inherited flags (e.g. -modcache) from
// widening `go clean`, and GOCACHE / GOMODCACHE pin the located directory.
const GO_NEUTRAL = { GOENV: 'off', GOFLAGS: '' };
export const CACHES = [
  {
    kind: 'npm',
    tool: 'npm',
    locations: () => [dirname(process.execPath)],
    locate: async (call) => [join(firstLine(await call(['config', 'get', 'cache'])), '_cacache')],
    label: 'npm cache',
    clean: (path) => ({ args: ['cache', 'clean', '--force', '--cache', dirname(path)] }),
  },
  {
    kind: 'pnpm',
    tool: 'pnpm',
    locations: (home) => [join(home, 'Library', 'pnpm')],
    locate: async (call) => [firstLine(await call(['store', 'path']))],
    label: 'pnpm store (prune removes unreferenced packages)',
    // The location is re-checked right before pruning; prune keeps referenced packages.
    clean: () => ({ args: ['store', 'prune'] }),
    reclaim: 'unknown',
  },
  {
    kind: 'uv',
    tool: 'uv',
    locations: (home) => [join(home, '.cargo', 'bin')],
    locate: async (call) => [firstLine(await call(['cache', 'dir']))],
    label: 'uv cache',
    clean: (path) => ({ args: ['cache', 'clean', '--cache-dir', path] }),
  },
  {
    kind: 'go-build',
    tool: 'go',
    locations: () => ['/usr/local/go/bin'],
    locate: async (call) => [firstLine(await call(['env', 'GOCACHE']))],
    label: 'Go build cache',
    clean: (path) => ({ args: ['clean', '-cache'], env: { ...GO_NEUTRAL, GOCACHE: path } }),
  },
  {
    kind: 'go-mod',
    tool: 'go',
    locations: () => ['/usr/local/go/bin'],
    locate: async (call) => [firstLine(await call(['env', 'GOMODCACHE']))],
    label: 'Go module cache',
    clean: (path) => ({ args: ['clean', '-modcache'], env: { ...GO_NEUTRAL, GOMODCACHE: path } }),
  },
];

// Absent paths are simply not caches; other errors (EACCES, ...) are reported.
async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw new Error(`cannot inspect ${path}: ${error.code ?? error.message}`);
  }
}

// uv's global link mode. With `symlink`, environments point into the cache and
// break when it is cleaned. Project-level settings are not inspected.
export async function uvLinkMode(env, home) {
  if (env.UV_LINK_MODE) return env.UV_LINK_MODE;
  const userConfig = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'uv', 'uv.toml') : join(home, '.config', 'uv', 'uv.toml');
  for (const file of [userConfig, '/etc/uv/uv.toml']) {
    try {
      const match = /^\s*link-mode\s*=\s*["']([a-z-]+)["']/m.exec(await readFile(file, 'utf8'));
      if (match) return match[1];
    } catch {
      // No config file.
    }
  }
  return 'clone (default on macOS)';
}

// The cache directory for `spec` and a runner for its tool, or null when the tool
// is not installed or the cache does not exist.
async function locate(spec, context) {
  const home = context.env.HOME ?? context.home;
  const bin = await resolveTool(spec.tool, context.env, { locations: spec.locations(home) });
  if (!bin) return null;
  const call = (args, overrides = {}) => runTool(bin, args, { ...context.env, ...overrides }, { cwd: home });
  const [path] = await spec.locate(call);
  if (!path || !(await isDirectory(path))) return null;
  return { call, path: (await realpathOrNull(path)) ?? path };
}

async function candidateFor(spec, path, context) {
  const home = context.env.HOME ?? context.home;
  const { args, env = {} } = spec.clean(path);
  const command = [...Object.entries(env).map(([key, value]) => `${key}=${value}`), spec.tool, ...args].join(' ');
  const evidence = { path, command };
  let itemClass = 'routine';
  if (spec.kind === 'uv') {
    evidence.link_mode = await uvLinkMode(context.env, home);
    if (evidence.link_mode === 'symlink') {
      itemClass = 'review';
      evidence.warning = 'uv link-mode is symlink: environments linked into this cache break when it is cleaned';
    }
  }
  return {
    id: itemId(NAME, `${spec.kind}\n${path}`),
    class: itemClass,
    detector: NAME,
    kind: spec.kind,
    label: `${spec.label} (${displayPath(path, context.home)})`,
    evidence,
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
        if (found) candidates.push(await candidateFor(spec, found.path, context));
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
    if (found.path !== item.evidence.path) throw new Error('cache location changed');
    const { args, env } = spec.clean(item.evidence.path);
    await found.call(args, env);
  },
};
