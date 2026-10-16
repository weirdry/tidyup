// tidyup entry point. The v1 contract is defined in docs/design.md.
import { realpathSync } from 'node:fs';
import { statfs as nodeStatfs } from 'node:fs/promises';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { apply } from './lib/apply.mjs';
import { renderApply, renderScan } from './lib/report.mjs';
import { resolveRoots, scan } from './lib/scan.mjs';

export const EXIT = Object.freeze({ ok: 0, error: 1, usage: 2, recommend: 10, urgent: 20 });

const USAGE = `Usage:
  tidyup scan [--deep] [--root <dir>]... [--json]
  tidyup apply <id>... [--reviewed <id>]... [--root <dir>]... [--json]

Commands:
  scan     Measure disk headroom; under pressure (or with --deep) list cleanup
           candidates. Read-only. Exit code: 0 ok, 10 recommend, 20 urgent.
  apply    Delete the selected candidates after re-checking them. Review items
           must be passed with --reviewed. Exit code: 0 if all were deleted.

Options:
  --deep           List candidates even when headroom is ok
  --root <dir>     Add a project root to search (repeatable)
  --reviewed <id>  Select a review item the user approved after seeing its evidence
  --json           Print the result as JSON
  -h, --help       Show this help`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  deep: { type: 'boolean' },
  root: { type: 'string', multiple: true },
  reviewed: { type: 'string', multiple: true },
};

function usageError(stderr, message) {
  stderr.write(`tidyup: ${message}\n\n${USAGE}\n`);
  return EXIT.usage;
}

export async function main(argv, {
  platform = process.platform,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  statfs = nodeStatfs,
  now = new Date(),
} = {}) {
  if (platform !== 'darwin') {
    stderr.write('tidyup supports macOS only\n');
    return EXIT.error;
  }

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    return usageError(stderr, error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }

  const [command, ...ids] = positionals;
  if (command === undefined) return usageError(stderr, 'missing command');
  if (command !== 'scan' && command !== 'apply') return usageError(stderr, `unknown command '${command}'`);
  if (command === 'scan' && (ids.length > 0 || values.reviewed)) return usageError(stderr, 'scan takes no IDs');
  if (command === 'apply' && values.deep) return usageError(stderr, '--deep applies to scan only');
  if (command === 'apply' && ids.length === 0 && !values.reviewed) return usageError(stderr, 'apply needs at least one ID');

  const home = env.HOME;
  if (!home) {
    stderr.write('tidyup: HOME is not set\n');
    return EXIT.error;
  }

  try {
    const roots = await resolveRoots(home, values.root ?? []);
    if (command === 'scan') {
      const report = await scan({ home, roots, deep: Boolean(values.deep), now, statfs, env });
      stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderScan(report, home));
      return EXIT[report.level] ?? EXIT.ok;
    }
    const result = await apply({ ids, reviewed: values.reviewed ?? [], home, roots, now, statfs, env });
    stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : renderApply(result, home));
    return result.outcomes.every((o) => o.outcome === 'deleted') ? EXIT.ok : EXIT.error;
  } catch (error) {
    stderr.write(`tidyup: ${error.message}\n`);
    return EXIT.error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}
