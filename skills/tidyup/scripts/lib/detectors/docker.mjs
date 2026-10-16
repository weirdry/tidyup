// Docker disk usage through the docker CLI, so any runtime (Colima, Docker
// Desktop, OrbStack) works. One detector yields several kinds of items:
//   build cache unused for 7+ days   routine   docker builder prune --filter until=168h
//   dangling images                  routine   docker image prune
//   unused tagged images             review    docker image rm <ref> for each tag
//   volumes                          judgment  never removed; sizes only
// IDs include the daemon ID, so an ID never applies to a different daemon. Image
// IDs also include the tags, so approval never extends to tags added after the scan.
// Each operation pins the docker context it started with (unless DOCKER_HOST
// already pins the endpoint), so a `docker context use` elsewhere cannot redirect it.
import { itemId } from '../fsutil.mjs';
import { resolveTool, runTool } from '../tools.mjs';

const NAME = 'docker';
export const BUILD_CACHE_IDLE_DAYS = 7;

// The docker CLI, or null when Docker is not installed. TIDYUP_DOCKER overrides.
export function resolveDocker(env) {
  return resolveTool('docker', env, {
    override: 'TIDYUP_DOCKER',
    locations: ['/Applications/Docker.app/Contents/Resources/bin'],
  });
}

const run = (bin, args, env) => runTool(bin, args, env);

// The docker endpoint for this operation, resolved once and cached on the context:
// `call(args)` runs the CLI pinned to it. Null when Docker is not installed.
async function endpoint(context) {
  if (context.docker !== undefined) return context.docker;
  const bin = await resolveDocker(context.env);
  if (!bin) {
    context.docker = null;
    return null;
  }
  const pin = context.env.DOCKER_HOST ? [] : ['--context', (await run(bin, ['context', 'show'], context.env)).trim()];
  const call = (args) => run(bin, [...pin, ...args], context.env);
  let daemonId;
  try {
    daemonId = (await call(['info', '--format', '{{.ID}}'])).trim();
  } catch (error) {
    throw new Error(`daemon not reachable (${error.message})`);
  }
  context.docker = { call, daemonId };
  return context.docker;
}

// Docker prints decimal sizes such as "24.58kB" or "1.223GB".
export function parseSize(text) {
  const match = /^([0-9.]+)\s*([kKMGTP]?)B$/.exec(String(text).trim());
  if (!match) return null;
  const power = ['', 'k', 'M', 'G', 'T', 'P'].indexOf(match[2] === 'K' ? 'k' : match[2]);
  return Math.round(Number(match[1]) * 1000 ** power);
}

// Docker timestamps look like "2026-10-09 18:43:43.829 +0000 UTC".
export function parseTimestamp(text) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-]\d{2})(\d{2})/.exec(text ?? '');
  if (!match) return null;
  const fraction = (match[3] ?? '').slice(0, 4);
  return new Date(`${match[1]}T${match[2]}${fraction}${match[4]}:${match[5]}`);
}

const isDangling = (row) => row.Repository === '<none>' && row.Tag === '<none>';

// Tags per image ID from `docker image ls` rows (one row per tag). `system df -v`
// shows only the first tag of an image, so it cannot supply the full set.
export function tagsById(rows) {
  const tags = new Map();
  for (const row of rows) {
    if (row.Tag === '<none>' || row.Repository === '<none>') continue;
    tags.set(row.ID, [...(tags.get(row.ID) ?? []), `${row.Repository}:${row.Tag}`]);
  }
  for (const list of tags.values()) list.sort();
  return tags;
}

// Items derived from one `docker system df -v` snapshot plus the tag map. Images
// whose container count is unknown are reported in `skipped`, never as candidates.
export function itemsFromUsage(usage, tags, daemonId, now) {
  const id = (kind, key = '') => itemId(NAME, `${daemonId}\n${kind}\n${key}`);
  const items = [];
  const skipped = [];

  const cutoff = now.getTime() - BUILD_CACHE_IDLE_DAYS * 24 * 60 * 60 * 1000;
  const oldCache = (usage.BuildCache ?? []).filter((record) => {
    const lastUsed = parseTimestamp(record.LastUsedAt) ?? parseTimestamp(record.CreatedAt);
    return record.InUse === 'false' && record.Shared === 'false' && lastUsed && lastUsed.getTime() < cutoff;
  });
  if (oldCache.length > 0) {
    items.push({
      id: id('build-cache'),
      class: 'routine',
      detector: NAME,
      kind: 'build-cache',
      label: `Docker build cache unused for ${BUILD_CACHE_IDLE_DAYS}+ days`,
      estimated_bytes: oldCache.reduce((sum, record) => sum + (parseSize(record.Size) ?? 0), 0),
      evidence: { records: oldCache.length, idle_days: BUILD_CACHE_IDLE_DAYS, excludes: 'shared and in-use records', daemon_id: daemonId },
    });
  }

  const images = usage.Images ?? [];
  const unknown = images.filter((row) => !/^\d+$/.test(row.Containers ?? ''));
  if (unknown.length > 0) {
    skipped.push({ detector: NAME, reason: `${unknown.length} image(s) not evaluated: container count unavailable` });
  }
  const dangling = images.filter((row) => isDangling(row) && row.Containers === '0');
  if (dangling.length > 0) {
    items.push({
      id: id('dangling-images'),
      class: 'routine',
      detector: NAME,
      kind: 'dangling-images',
      label: `Dangling Docker images (${dangling.length})`,
      estimated_bytes: dangling.reduce((sum, row) => sum + (parseSize(row.UniqueSize) ?? 0), 0),
      evidence: { images: dangling.length, daemon_id: daemonId },
    });
  }

  const imageItems = [];
  for (const row of images) {
    const refs = tags.get(row.ID);
    if (isDangling(row) || row.Containers !== '0' || !refs) continue;
    const imageId = row.ID;
    imageItems.push({
      id: id('image', `${imageId}\n${refs.join('\n')}`),
      class: 'review',
      detector: NAME,
      kind: 'image',
      label: `Docker image ${refs.join(', ')}`,
      estimated_bytes: parseSize(row.UniqueSize),
      evidence: { image_id: imageId, refs, daemon_id: daemonId, created: row.CreatedAt, used_by_containers: 0 },
    });
  }
  items.push(...imageItems.sort((a, b) => (b.estimated_bytes ?? 0) - (a.estimated_bytes ?? 0)));

  const volumes = usage.Volumes ?? [];
  if (volumes.length > 0) {
    const sized = volumes
      .map((volume) => ({ name: volume.Name, bytes: parseSize(volume.Size), containers: Number(volume.Links) }))
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    items.push({
      class: 'judgment',
      detector: NAME,
      kind: 'volumes',
      label: `Docker volumes (${volumes.length}; ${sized.filter((v) => v.containers === 0).length} unattached)`,
      estimated_bytes: sized.reduce((sum, volume) => sum + (volume.bytes ?? 0), 0),
      evidence: { largest: sized.slice(0, 10) },
    });
  }
  return { items, skipped };
}

async function snapshot(context) {
  const target = await endpoint(context);
  if (!target) return null;
  const usage = JSON.parse(await target.call(['system', 'df', '-v', '--format', 'json']));
  const rows = (await target.call(['image', 'ls', '--no-trunc', '--format', '{{json .}}']))
    .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  return itemsFromUsage(usage, tagsById(rows), target.daemonId, context.now);
}

export default {
  name: NAME,

  async discover(context) {
    const result = await snapshot(context);
    if (!result) return { candidates: [], skipped: [] };
    return { candidates: result.items.filter((item) => item.id), skipped: result.skipped };
  },

  // Fresh, cheap checks immediately before removal.
  async evaluate(candidate, context) {
    try {
      const target = await endpoint(context);
      if (!target) return { eligible: false, reason: 'docker CLI not found' };
      const daemonId = (await target.call(['info', '--format', '{{.ID}}'])).trim();
      if (daemonId !== candidate.evidence.daemon_id) return { eligible: false, reason: 'docker daemon changed' };
      if (candidate.kind === 'image') {
        const tags = JSON.parse(await target.call(['image', 'inspect', candidate.evidence.image_id, '--format', '{{json .RepoTags}}']));
        if (JSON.stringify([...tags].sort()) !== JSON.stringify(candidate.evidence.refs)) return { eligible: false, reason: 'image tags changed' };
        const users = (await target.call(['container', 'ls', '-a', '-q', '--filter', `ancestor=${candidate.evidence.image_id}`])).trim();
        if (users) return { eligible: false, reason: 'image is used by a container' };
        return { eligible: true };
      }
      const current = await snapshot(context);
      if (!current?.items.some((item) => item.id === candidate.id)) return { eligible: false, reason: 'nothing left to remove' };
      return { eligible: true };
    } catch (error) {
      return { eligible: false, reason: error.message, error: true };
    }
  },

  async detect(context) {
    try {
      return (await snapshot(context)) ?? { items: [], skipped: [] };
    } catch (error) {
      return { items: [], skipped: [{ detector: NAME, reason: error.message }] };
    }
  },

  async remove(item, context) {
    const target = await endpoint(context);
    if (!target) throw new Error('docker CLI not found');
    if (item.kind === 'build-cache') {
      await target.call(['builder', 'prune', '--force', '--filter', `until=${BUILD_CACHE_IDLE_DAYS * 24}h`]);
    } else if (item.kind === 'dangling-images') {
      await target.call(['image', 'prune', '--force']);
    } else if (item.kind === 'image') {
      for (const ref of item.evidence.refs) await target.call(['image', 'rm', ref]);
    } else {
      throw new Error(`cannot remove ${item.kind}`);
    }
  },
};
