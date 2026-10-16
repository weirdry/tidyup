// Locating and running external CLIs (docker, npm, pnpm, uv, go). GUI apps and
// scheduled tasks often lack Homebrew, mise, or the Node directory on PATH, so
// common install locations are searched after PATH.
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Absolute path of `name`, or null when it is not installed. `override` names an
// environment variable that, when set, must point at an executable.
export async function resolveTool(name, env, { override, locations = [] } = {}) {
  if (override && env[override]) {
    if (await executable(env[override])) return env[override];
    throw new Error(`${override}=${env[override]} is not executable`);
  }
  const home = env.HOME;
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    ...locations,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(home ? [join(home, '.local', 'bin'), join(home, '.local', 'share', 'mise', 'shims')] : []),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

// Runs a tool and resolves with stdout. The directory of the running Node is put
// first on PATH so Node-based CLIs (npm) work where node is not on PATH. `cwd`
// matters for tools that read project-level config (.npmrc, uv.toml).
export function runTool(bin, args, env, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  const path = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: { ...env, PATH: path }, cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${bin.split('/').pop()} ${args.join(' ')} failed: ${stderr.trim().split('\n')[0] || error.message}`));
      else resolve(stdout);
    });
  });
}
