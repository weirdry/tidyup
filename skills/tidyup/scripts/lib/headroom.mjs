// Disk headroom of the filesystem that contains a path, and its pressure level.
import { statfs } from 'node:fs/promises';

export const RECOMMEND_PERCENT = 20;
export const URGENT_PERCENT = 10;

export function levelFor(availablePercent) {
  if (availablePercent <= URGENT_PERCENT) return 'urgent';
  if (availablePercent <= RECOMMEND_PERCENT) return 'recommend';
  return 'ok';
}

// available = bavail × bsize (space usable without privileges); total = blocks × bsize.
export async function measureHeadroom(path, statfsImpl = statfs) {
  const stats = await statfsImpl(path);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const availablePercent = totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0;
  return {
    measured_path: path,
    total_bytes: totalBytes,
    available_bytes: availableBytes,
    available_percent: Math.round(availablePercent * 10) / 10,
    level: levelFor(availablePercent),
  };
}
