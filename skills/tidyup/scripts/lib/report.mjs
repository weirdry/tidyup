// Human-readable rendering of scan and apply results. JSON output is the raw
// result object; this module only formats it for people.
import { RECOMMEND_PERCENT } from './headroom.mjs';
import { displayPath, formatBytes } from './fsutil.mjs';

function headroomLine(h) {
  return `Disk headroom: ${formatBytes(h.available_bytes)} free of ${formatBytes(h.total_bytes)} ` +
    `(${h.available_percent}%) — ${h.level.toUpperCase()}`;
}

function table(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => row.map((cell, col) => (col === 2 ? cell.padStart(widths[col]) : cell.padEnd(widths[col])))
    .join('  ').trimEnd()).join('\n');
}

function describe(item, home) {
  return item.path === undefined ? item.label : displayPath(item.path, home);
}

export function renderScan(report, home) {
  const lines = [headroomLine(report), `Measured: ${displayPath(report.measured_path, home)}`, ''];

  if (!report.candidates_measured) {
    lines.push(`Headroom is above ${RECOMMEND_PERCENT}%, so candidates were not measured. Use --deep to list them.`);
  } else if (report.items.length === 0) {
    lines.push('No cleanup candidates found.');
  } else {
    const rows = [['ID', 'CLASS', 'EST. SIZE', 'ITEM']];
    for (const item of report.items) {
      rows.push([item.id ?? '-', item.class, formatBytes(item.estimated_bytes), describe(item, home)]);
    }
    lines.push(table(rows), '');
    const routine = report.items.filter((item) => item.class === 'routine');
    const total = routine.reduce((sum, item) => sum + (item.estimated_bytes ?? 0), 0);
    lines.push(
      `Routine total: ${formatBytes(total)} (estimate; shared APFS clones and hard links can make actual freed space lower)`,
      'To delete, run: tidyup apply <id> [<id> ...] with the same --root options.',
    );
  }

  if (report.skipped.length > 0) {
    lines.push('', 'Skipped:');
    for (const entry of report.skipped) lines.push(`  ${entry.detector}: ${entry.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderApply(result, home) {
  const lines = [];
  for (const o of result.outcomes) {
    const target = o.path ? displayPath(o.path, home) : (o.label ?? '');
    const reason = o.reason ? ` (${o.reason})` : '';
    lines.push(`${o.outcome.padEnd(8)}  ${o.id}  ${target}${reason}`.trimEnd());
  }
  const freed = result.after.available_bytes - result.before.available_bytes;
  lines.push(
    '',
    `Disk headroom: ${formatBytes(result.before.available_bytes)} → ${formatBytes(result.after.available_bytes)} free ` +
      `(${freed >= 0 ? '+' : '-'}${formatBytes(Math.abs(freed))}), now ${result.after.level.toUpperCase()}`,
  );
  if (result.skipped.length > 0) {
    lines.push('', 'Skipped:');
    for (const entry of result.skipped) lines.push(`  ${entry.detector}: ${entry.reason}`);
  }
  return `${lines.join('\n')}\n`;
}
