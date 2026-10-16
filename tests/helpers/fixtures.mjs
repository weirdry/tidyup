// Synthetic fixtures for tests. Everything lives under a fresh temporary
// directory; tests never touch the real home directory.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CACHEDIR_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag.\n';

// A temporary "home" directory, resolved through /var → /private/var.
export function makeHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'tidyup-home-')));
}

export function removeTree(path) {
  rmSync(path, { recursive: true, force: true });
}

export function writeFiles(base, files) {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(base, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

// Sets atime/mtime of `path` and everything below it to `days` ago, children first.
export function age(path, days) {
  const time = new Date(Date.now() - days * DAY_MS);
  const stats = lstatSync(path);
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) age(join(path, name), days);
  }
  if (!stats.isSymbolicLink()) utimesSync(path, time, time);
}

// A Cargo project at `home/relative` with a target directory.
// marker: 'tag' (CACHEDIR.TAG), 'fingerprint' (target/debug/.fingerprint), or null.
export function cargoProject(home, relative, { marker = 'tag', idleDays = 30 } = {}) {
  const project = join(home, relative);
  const files = {
    'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    'target/debug/build-output.bin': 'x'.repeat(4096),
  };
  if (marker === 'tag') files['target/CACHEDIR.TAG'] = CACHEDIR_TAG;
  if (marker === 'fingerprint') files['target/debug/.fingerprint/fixture/hash'] = 'fp';
  writeFiles(project, files);
  if (idleDays > 0) age(project, idleDays);
  return { project, target: join(project, 'target') };
}

export function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

// A statfs stand-in reporting `percent` of a 1000-block volume as available.
export function fakeStatfs(percent) {
  return async () => ({ blocks: 1000, bsize: 4096, bavail: Math.round(10 * percent) });
}

// A fake docker CLI backed by `state.json` in its own directory. It logs each
// invocation to `calls.log` and applies removals to the state, like the real CLI.
// `state.ancestors` lists image IDs that `container ls --filter ancestor=` reports as
// used even though `system df` does not yet count them (a container started meanwhile).
const FAKE_DOCKER = `
const fs = require('node:fs');
const path = require('node:path');
const statePath = path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\\n');
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
const ref = (image) => image.Repository + ':' + image.Tag;
if (!state.up) fail('Cannot connect to the Docker daemon');
const [a, b] = args;
if (a === 'info') console.log(state.id);
else if (a === 'system' && b === 'df') console.log(JSON.stringify({ Images: state.images, Containers: [], Volumes: state.volumes, BuildCache: state.buildCache }));
else if (a === 'image' && b === 'inspect') {
  const rows = state.images.filter((image) => image.ID === args[2]);
  if (rows.length === 0) fail('No such image');
  console.log(JSON.stringify(rows.filter((image) => image.Tag !== '<none>').map(ref)));
} else if (a === 'container' && b === 'ls') {
  const ancestor = args.find((arg) => arg.startsWith('ancestor=')).slice('ancestor='.length);
  const used = state.images.some((image) => image.ID === ancestor && image.Containers !== '0') || (state.ancestors ?? []).includes(ancestor);
  console.log(used ? 'c0ffee' : '');
} else if (a === 'image' && b === 'rm') {
  state.images = state.images.filter((image) => ref(image) !== args[2]);
  save();
} else if (a === 'image' && b === 'prune') {
  state.images = state.images.filter((image) => !(image.Repository === '<none>' && image.Containers === '0'));
  save();
} else if (a === 'builder' && b === 'prune') {
  state.buildCache = state.buildCache.filter((record) => record.InUse === 'true');
  save();
} else fail('unsupported: ' + args.join(' '));
`;

export function fakeDocker(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tidyup-docker-'));
  const full = { up: true, id: 'daemon-a', images: [], volumes: [], buildCache: [], ...state };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(full));
  writeFileSync(join(dir, 'calls.log'), '');
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!${process.execPath}\n${FAKE_DOCKER}`, { mode: 0o755 });
  return {
    bin,
    dir,
    calls: () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    update: (patch) => writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), ...patch })),
  };
}

let emptyDocker;

// Runs main() with captured output. Docker is an empty fake unless `docker` is given,
// so tests never reach a real Docker installation.
export async function runMain(main, argv, { home, percent = 50, docker, ...rest } = {}) {
  emptyDocker ??= fakeDocker();
  const out = { stdout: '', stderr: '' };
  const code = await main(argv, {
    platform: 'darwin',
    stdout: { write: (text) => { out.stdout += text; } },
    stderr: { write: (text) => { out.stderr += text; } },
    env: { HOME: home, TIDYUP_DOCKER: (docker ?? emptyDocker).bin },
    statfs: fakeStatfs(percent),
    ...rest,
  });
  return { code, ...out };
}
