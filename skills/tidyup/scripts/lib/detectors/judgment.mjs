// Judgment items: data only the user can weigh. They get no ID and are never
// removed by tidyup; each carries a size, an evidence summary, and a hint for
// removing it by hand.
//   model-caches    the Hugging Face hub cache (models re-download, slowly)
//   app-containers  ~/Library/Containers left behind by apps no longer installed
//   homebrew        what `brew cleanup` would free (it also removes old formula versions)
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { displayPath, formatBytes, realpathOrNull } from '../fsutil.mjs';
import { resolveTool, runTool } from '../tools.mjs';

const MiB = 1024 * 1024;
// Listing every small container would bury the few that matter.
export const LEFTOVER_MIN_BYTES = 100 * MiB;
export const UNIDENTIFIED_MIN_BYTES = 1024 * MiB;
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

const none = { candidates: [], skipped: [] };

// `du -k -d 1 <dir>`: sizes of `dir`'s children in one traversal. Entries du
// cannot read are returned in `unreadable`.
function childSizes(dir) {
  return new Promise((resolve) => {
    execFile('du', ['-k', '-d', '1', dir], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * MiB }, (error, stdout, stderr) => {
      const sizes = new Map();
      for (const line of stdout.split('\n')) {
        const match = /^(\d+)\t(.+)$/.exec(line);
        if (match && match[2] !== dir) sizes.set(match[2], Number(match[1]) * 1024);
      }
      const unreadable = stderr.split('\n').filter((line) => line.startsWith('du: ')).map((line) => line.slice(4));
      resolve({ sizes, unreadable, failed: Boolean(error) && sizes.size === 0 });
    });
  });
}

const largestList = (entries, count = 3) =>
  entries.slice(0, count).map((entry) => `${entry.name} (${formatBytes(entry.bytes)})`).join(', ');

export function huggingFaceHub(env, home) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HUGGINGFACE_HUB_CACHE) return env.HUGGINGFACE_HUB_CACHE;
  const hfHome = env.HF_HOME ?? join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'huggingface');
  return join(hfHome, 'hub');
}

export const modelCaches = {
  name: 'model-caches',
  discover: async () => none,

  async detect(context) {
    const hub = await realpathOrNull(huggingFaceHub(context.env, context.env.HOME ?? context.home));
    if (!hub || !(await stat(hub)).isDirectory()) return { items: [], skipped: [] };
    const { sizes, unreadable } = await childSizes(hub);
    const models = [...sizes]
      .filter(([path]) => basename(path).startsWith('models--'))
      .map(([path, bytes]) => ({ name: basename(path).slice('models--'.length).replace('--', '/'), bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    if (models.length === 0) return { items: [], skipped: [] };
    const total = models.reduce((sum, model) => sum + model.bytes, 0);
    return {
      items: [{
        class: 'judgment',
        detector: 'model-caches',
        kind: 'huggingface',
        label: `Hugging Face model cache (${models.length} models; ${displayPath(hub, context.home)})`,
        estimated_bytes: total,
        evidence: {
          path: hub,
          largest: models.slice(0, 10),
          hint: 'huggingface-cli delete-cache, or remove specific models--* folders; models download again when used',
          summary: `largest: ${largestList(models)}`,
        },
      }],
      skipped: unreadable.length > 0 ? [{ detector: 'model-caches', reason: `${unreadable.length} entries could not be measured` }] : [],
    };
  },
};

// Bundle identifiers of installed apps, from one Spotlight query. Null when
// Spotlight does not answer (it then cannot tell installed apps apart).
async function installedBundleIds(env) {
  const bin = await resolveTool('mdfind', env);
  if (!bin) return null;
  try {
    const output = await runTool(bin, ['-attr', 'kMDItemCFBundleIdentifier', "kMDItemContentType == 'com.apple.application-bundle'"], env);
    const ids = new Set();
    for (const match of output.matchAll(/kMDItemCFBundleIdentifier = (\S+)/g)) ids.add(match[1].toLowerCase());
    return ids.has('com.apple.finder') ? ids : null;
  } catch {
    return null;
  }
}

// True when an installed app's identifier equals `id` or is a parent of it
// (extensions and helpers use the app's identifier plus a suffix).
export function isInstalled(id, installed) {
  const lower = id.toLowerCase();
  for (const app of installed) {
    if (lower === app || lower.startsWith(`${app}.`) || lower.startsWith(`${app}-`)) return true;
  }
  return false;
}

// Containers worth showing: identified ones whose app is not installed (at least
// LEFTOVER_MIN_BYTES), and unidentifiable UUID-named ones (at least
// UNIDENTIFIED_MIN_BYTES). Apple's own containers are skipped.
export function leftoverContainers(sizes, installed) {
  const result = [];
  for (const [path, bytes] of sizes) {
    const id = basename(path);
    if (id.toLowerCase().startsWith('com.apple.')) continue;
    const identified = !UUID.test(id);
    if (identified ? bytes < LEFTOVER_MIN_BYTES || isInstalled(id, installed) : bytes < UNIDENTIFIED_MIN_BYTES) continue;
    result.push({ path, id, bytes, identified });
  }
  return result.sort((a, b) => b.bytes - a.bytes);
}

export const appContainers = {
  name: 'app-containers',
  discover: async () => none,

  async detect(context) {
    const home = context.env.HOME ?? context.home;
    const root = context.paths?.appContainersRoot ?? join(home, 'Library', 'Containers');
    try {
      await readdir(root);
    } catch (error) {
      if (error.code === 'ENOENT') return { items: [], skipped: [] };
      return { items: [], skipped: [{ detector: 'app-containers', reason: `cannot read ${root}: ${error.code ?? error.message}` }] };
    }
    const installed = await installedBundleIds(context.env);
    if (!installed) return { items: [], skipped: [{ detector: 'app-containers', reason: 'Spotlight is unavailable, so installed apps cannot be identified' }] };

    const { sizes, unreadable } = await childSizes(root);
    const items = [];
    for (const { path, id, bytes, identified } of leftoverContainers(sizes, installed)) {
      const modified = (await stat(path).catch(() => null))?.mtime;
      items.push({
        class: 'judgment',
        detector: 'app-containers',
        kind: identified ? 'leftover' : 'unidentified',
        label: identified ? `Leftover data of uninstalled app ${id}` : `App container ${id} (app not identifiable)`,
        estimated_bytes: bytes,
        evidence: {
          path,
          modified: modified?.toISOString() ?? null,
          hint: 'macOS protects other apps\' containers: move the folder to the Trash in Finder',
          summary: identified
            ? `no installed app ${id} found by Spotlight; last modified ${modified?.toISOString().slice(0, 10) ?? 'unknown'}`
            : `container metadata is protected, so its app is unknown; last modified ${modified?.toISOString().slice(0, 10) ?? 'unknown'}`,
        },
      });
    }
    const thirdPartyUnreadable = unreadable.filter((line) => !line.includes('/com.apple.'));
    const skipped = thirdPartyUnreadable.length > 0
      ? [{ detector: 'app-containers', reason: `${thirdPartyUnreadable.length} third-party container entries could not be measured (macOS privacy protection)` }]
      : [];
    return { items, skipped };
  },
};

// Parses "This operation would free approximately 1.5GB of disk space." Homebrew
// reports binary multiples with decimal-looking units.
export function parseBrewFree(output) {
  const match = /would free approximately ([\d.]+)\s*([KMGT]?B)/.exec(output);
  if (!match) return null;
  const power = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(match[2]);
  return Math.round(Number(match[1]) * 1024 ** power);
}

export const homebrew = {
  name: 'homebrew',
  discover: async () => none,

  async detect(context) {
    const bin = await resolveTool('brew', context.env);
    if (!bin) return { items: [], skipped: [] };
    let output;
    try {
      output = await runTool(bin, ['cleanup', '--dry-run'], {
        ...context.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_ANALYTICS: '1',
      }, { cwd: context.env.HOME ?? context.home });
    } catch (error) {
      return { items: [], skipped: [{ detector: 'homebrew', reason: error.message }] };
    }
    const bytes = parseBrewFree(output);
    if (!bytes) return { items: [], skipped: [] };
    return {
      items: [{
        class: 'judgment',
        detector: 'homebrew',
        kind: 'cleanup',
        label: 'Homebrew cleanup (old versions, downloads, and caches)',
        estimated_bytes: bytes,
        evidence: {
          command: 'brew cleanup',
          hint: 'run `brew cleanup` yourself; it also removes old installed formula versions',
          summary: 'brew cleanup --dry-run reports this; it also removes old installed formula versions',
        },
      }],
      skipped: [],
    };
  },
};
