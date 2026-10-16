// Docker disk usage through the docker CLI, so any runtime (Colima, Docker
// Desktop, OrbStack) works. One detector yields several kinds of items:
//   build cache unused for 7+ days   routine   docker builder prune --filter until=168h
//   dangling images                  routine   docker image prune
//   unused tagged images             review    docker image rm <ref> for each tag
//   volumes                          judgment  never removed; sizes only
// IDs include the daemon ID, so an ID never applies to a different daemon. Image
// IDs also include the tags, so approval never extends to tags added after the scan.
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { itemId } from '../fsutil.mjs';

const NAME = 'docker';
export const BUILD_CACHE_IDLE_DAYS = 7;
const TIMEOUT_MS = 2 * 60 * 1000;
const KNOWN_LOCATIONS = [
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
];

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The docker CLI to use, or null when Docker is not installed. GUI apps and
// scheduled tasks often lack Homebrew on PATH, so known locations are checked too.
export async function resolveDocker(env) {
  if (env.TIDYUP_DOCKER) {
    if (await executable(env.TIDYUP_DOCKER)) return env.TIDYUP_DOCKER;
    throw new Error(`TIDYUP_DOCKER=${env.TIDYUP_DOCKER} is not executable`);
  }
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'docker'));
  for (const candidate of [...onPath, ...KNOWN_LOCATIONS]) {
    if (await executable(candidate)) return candidate;
  }
  return null;
}

function docker(bin, args, env) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args[0]} failed: ${stderr.trim().split('\n')[0] || error.message}`));
      else resolve(stdout);
    });
  });
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

// Items derived from one consistent `docker system df -v` snapshot.
export function itemsFromUsage(usage, daemonId, now) {
  const id = (kind, key = '') => itemId(NAME, `${daemonId}\n${kind}\n${key}`);
  const items = [];

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
      evidence: { records: oldCache.length, idle_days: BUILD_CACHE_IDLE_DAYS, excludes: 'shared and in-use records' },
    });
  }

  const images = usage.Images ?? [];
  const dangling = images.filter((row) => isDangling(row) && row.Containers === '0');
  if (dangling.length > 0) {
    items.push({
      id: id('dangling-images'),
      class: 'routine',
      detector: NAME,
      kind: 'dangling-images',
      label: `Dangling Docker images (${dangling.length})`,
      estimated_bytes: dangling.reduce((sum, row) => sum + (parseSize(row.UniqueSize) ?? 0), 0),
      evidence: { images: dangling.length },
    });
  }

  const unused = new Map();
  for (const row of images) {
    if (isDangling(row) || row.Containers !== '0' || row.Tag === '<none>') continue;
    const entry = unused.get(row.ID) ?? { row, refs: [] };
    entry.refs.push(`${row.Repository}:${row.Tag}`);
    unused.set(row.ID, entry);
  }
  const imageItems = [];
  for (const [imageId, { row, refs }] of unused) {
    refs.sort();
    imageItems.push({
      id: id('image', `${imageId}\n${refs.join('\n')}`),
      class: 'review',
      detector: NAME,
      kind: 'image',
      label: `Docker image ${refs.join(', ')}`,
      estimated_bytes: parseSize(row.UniqueSize),
      evidence: { image_id: imageId, refs, created: row.CreatedAt, used_by_containers: 0 },
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
  return items;
}

async function snapshot(context) {
  const bin = await resolveDocker(context.env);
  if (!bin) return null;
  let daemonId;
  try {
    daemonId = (await docker(bin, ['info', '--format', '{{.ID}}'], context.env)).trim();
  } catch (error) {
    throw new Error(`daemon not reachable (${error.message})`);
  }
  const usage = JSON.parse(await docker(bin, ['system', 'df', '-v', '--format', 'json'], context.env));
  return { bin, items: itemsFromUsage(usage, daemonId, context.now) };
}

export default {
  name: NAME,

  async discover(context) {
    const result = await snapshot(context);
    if (!result) return { candidates: [], skipped: [] };
    return { candidates: result.items.filter((item) => item.id), skipped: [] };
  },

  // Fresh, cheap checks immediately before removal.
  async evaluate(candidate, context) {
    try {
      const bin = await resolveDocker(context.env);
      if (!bin) return { eligible: false, reason: 'docker CLI not found' };
      if (candidate.kind === 'image') {
        const tags = JSON.parse(await docker(bin, ['image', 'inspect', candidate.evidence.image_id, '--format', '{{json .RepoTags}}'], context.env));
        if (JSON.stringify([...tags].sort()) !== JSON.stringify(candidate.evidence.refs)) return { eligible: false, reason: 'image tags changed' };
        const users = (await docker(bin, ['container', 'ls', '-a', '-q', '--filter', `ancestor=${candidate.evidence.image_id}`], context.env)).trim();
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
      const result = await snapshot(context);
      return { items: result?.items ?? [], skipped: [] };
    } catch (error) {
      return { items: [], skipped: [{ detector: NAME, reason: error.message }] };
    }
  },

  async remove(item, context) {
    const bin = await resolveDocker(context.env);
    if (!bin) throw new Error('docker CLI not found');
    if (item.kind === 'build-cache') {
      await docker(bin, ['builder', 'prune', '--force', '--filter', `until=${BUILD_CACHE_IDLE_DAYS * 24}h`], context.env);
    } else if (item.kind === 'dangling-images') {
      await docker(bin, ['image', 'prune', '--force'], context.env);
    } else if (item.kind === 'image') {
      for (const ref of item.evidence.refs) await docker(bin, ['image', 'rm', ref], context.env);
    } else {
      throw new Error(`cannot remove ${item.kind}`);
    }
  },
};
