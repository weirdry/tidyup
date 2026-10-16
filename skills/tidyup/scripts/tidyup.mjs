// tidyup entry point. The v1 contract is defined in docs/design.md.
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

export const EXIT = Object.freeze({ ok: 0, error: 1, usage: 2 });

const USAGE = `Usage: tidyup <command> [options]

Commands:
  scan     Measure disk headroom and list cleanup candidates (read-only)
  apply    Delete selected candidates by ID

Options:
  -h, --help  Show this help

tidyup is under development: scan and apply are not implemented yet.`;

export function main(argv, { platform = process.platform, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (platform !== 'darwin') {
    stderr.write('tidyup supports macOS only\n');
    return EXIT.error;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
  } catch (error) {
    stderr.write(`tidyup: ${error.message}\n\n${USAGE}\n`);
    return EXIT.usage;
  }

  if (parsed.values.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }

  const [command] = parsed.positionals;
  if (command === 'scan' || command === 'apply') {
    stderr.write(`tidyup: ${command} is not implemented yet\n`);
    return EXIT.error;
  }

  stderr.write(command === undefined ? `${USAGE}\n` : `tidyup: unknown command '${command}'\n\n${USAGE}\n`);
  return EXIT.usage;
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
