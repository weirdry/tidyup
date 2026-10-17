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
    '/usr/bin',
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

// Failure messages end up in reports and scheduled-task logs, so they are kept to
// one bounded line and likely credentials are masked. Masking covers the values of
// supplied environment variables with sensitive names and of sensitive arguments,
// URL user info, authorization headers, key=value, quoted "key": "value", and
// --flag value pairs with sensitive names, and a few well-known token prefixes. It
// cannot recognize every secret format.
const MAX_OUTPUT_LINES = 3;
const MAX_OUTPUT_CHARS = 300;
const MAX_COMMAND_CHARS = 160;
// Masking runs before truncation, on at most this much of each output stream.
const MAX_SCANNED_CHARS = 64 * 1024;
const MASK = '***';
const SENSITIVE_NAME = /token|secret|passw|passphrase|credential|auth|api[_-]?key|private[_-]?key|access[_-]?key|cookie|session/i;
const SENSITIVE_FLAG = /^--?[\w-]*(?:token|secret|passw|credential|auth|api-?key)[\w-]*$/i;
// Name parts are bounded so long unbroken output cannot cause heavy backtracking.
const PATTERNS = [
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]+@/gi, `$1${MASK}@`],
  [/\b((?:proxy-)?authorization\s*[:=]\s*)(?:(basic|bearer|digest|token)\s+)?[^\s,;]+/gi, (_, key, scheme) => `${key}${scheme ? `${scheme} ` : ''}${MASK}`],
  [/\b(bearer\s+)[\w.~+/=-]+/gi, `$1${MASK}`],
  // A quoted value, as in JSON, may contain spaces, escaped quotes, and line breaks.
  // It is masked whole, up to its closing quote, which is escaped too when the key's
  // quotes are (JSON inside a JSON string), or without one to the end of the
  // inspected text. Masking only part of a value would bring the rest into view.
  [/(?<![\w.-])((\\?["']?)[\w.-]{0,64}?(?:token|secret|passw|pwd|auth|api[_-]?key|credential)[\w.-]{0,64}\2\s*[=:]\s*(\\?["']))(?:(?!\3)(?:\\[^]|[^]))+/gi, `$1${MASK}`],
  // A scheme and its value are left to the authorization pattern above.
  [/(?<![\w.-])([\w.-]{0,64}?(?:token|secret|passw|pwd|auth|api[_-]?key|credential)[\w.-]{0,64}\s*[=:]\s*["']?)(?!(?:basic|bearer|digest|token)\s)[^\s"'&,;]+/gi, `$1${MASK}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|xox[abprs]-[\w-]{10,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16})\b/g, MASK],
];
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// An escape sequence cut off by the end of the inspected text.
const CUT_ANSI = /\x1b(?:\[[0-?]*[ -/]*)?$/;
// Control and invisible format characters (bidi overrides, line separators).
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// Values passed as `--flag value` or `--flag=value` with a sensitive flag name.
function argumentValues(args) {
  return args.flatMap((arg, i) => {
    if (i > 0 && SENSITIVE_FLAG.test(args[i - 1])) return [arg];
    const eq = arg.indexOf('=');
    return eq > 0 && SENSITIVE_FLAG.test(arg.slice(0, eq)) ? [arg.slice(eq + 1)] : [];
  });
}

// Values of supplied environment variables with sensitive names and of sensitive
// arguments, which a tool may echo without a label, longest first. Each line of a
// multi-line value (such as a PEM key) is masked on its own too, because output is
// shown line by line, and so is a value with its escape sequences removed.
function secretValues(env, args) {
  const values = new Set();
  const known = [
    ...Object.entries(env).filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === 'string').map(([, value]) => value),
    ...argumentValues(args),
  ];
  for (const value of known) {
    for (const part of [value, ...value.split(/\r?\n|\r/).map((line) => line.trim())]) {
      for (const form of [part, part.replace(ANSI, '')]) if (form.length >= 4) values.add(form);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

// The length of the longest proper prefix of `value` that `text` ends with, found
// in linear time (Knuth-Morris-Pratt).
function cutLength(text, value) {
  const fail = [0];
  for (let i = 1, k = 0; i < value.length; i += 1) {
    while (k > 0 && value[i] !== value[k]) k = fail[k - 1];
    if (value[i] === value[k]) k += 1;
    fail.push(k);
  }
  const tail = text.slice(-(value.length - 1));
  let k = 0;
  for (let i = 0; i < tail.length; i += 1) {
    while (k > 0 && tail[i] !== value[k]) k = fail[k - 1];
    if (tail[i] === value[k]) k += 1;
  }
  return k;
}

// Known values are masked before escape sequences are removed, in case a value
// contains one, and again after, in case one splits a value. When the text was
// `cut` at the inspection limit, a known value it ends partway through is masked
// too. The patterns run on the text without escape sequences.
function redact(text, secrets, cut = false) {
  const mask = (value) => secrets.reduce((result, secret) => result.split(secret).join(MASK), value);
  let result = mask(mask(text).replace(ANSI, ''));
  if (cut) {
    const length = Math.max(0, ...secrets.map((secret) => cutLength(result, secret)));
    if (length) result = `${result.slice(0, -length)}${MASK}`;
  }
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

// Already redacted text with escape sequences removed, other control characters
// escaped, and at most `max` characters.
function bound(text, max) {
  const escaped = text.replace(ANSI, '').replace(CONTROL, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);
  return escaped.length > max ? `${escaped.slice(0, max)}…` : escaped;
}

// The first non-empty lines of a child's output stream, as one line. Output past
// the inspection limit is dropped, along with an escape sequence the limit cuts.
function excerpt(text, secrets) {
  const cut = text.length > MAX_SCANNED_CHARS;
  const inspected = cut ? text.slice(0, MAX_SCANNED_CHARS).replace(CUT_ANSI, '') : text;
  const lines = redact(inspected, secrets, cut).split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
  return bound(lines.slice(0, MAX_OUTPUT_LINES).join(' | '), MAX_OUTPUT_CHARS);
}

// Why the child failed: its exit code or signal, a timeout, an oversized output,
// or a spawn error code such as ENOENT. Node marks a child it killed itself (on
// timeout or buffer overflow) as `killed`.
function failureCause(error, timeoutMs) {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output exceeded the buffer limit';
  if (typeof error.code === 'string') return error.code;
  const status = error.signal ? `signal ${error.signal}` : typeof error.code === 'number' ? `exit code ${error.code}` : 'no exit status';
  return error.killed ? `timed out after ${timeoutMs / 1000}s, ${status}` : status;
}

// One-line description of a failed run, built from the parts of the result that
// are safe to show, never from the raw error message, which embeds the command
// and the whole stderr.
function describeFailure(bin, args, env, error, stdout, stderr, timeoutMs) {
  const secrets = secretValues(env, args);
  const shownArgs = args.map((arg, i) => (i > 0 && SENSITIVE_FLAG.test(args[i - 1]) ? MASK : arg));
  const command = bound(redact([bin.split('/').pop(), ...shownArgs].join(' '), secrets), MAX_COMMAND_CHARS);
  const output = [];
  if (stderr.trim()) output.push(excerpt(stderr, secrets));
  if (stdout.trim()) output.push(`stdout: ${excerpt(stdout, secrets)}`);
  return `${command} failed (${failureCause(error, timeoutMs)}): ${output.join('; ') || 'no output'}`;
}

// Runs a tool and resolves with stdout. The directory of the running Node is put
// first on PATH so Node-based CLIs (npm) work where node is not on PATH. `cwd`
// matters for tools that read project-level config (.npmrc, uv.toml). A failure
// rejects with a bounded, redacted description (see describeFailure).
export function runTool(bin, args, env, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  const path = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: { ...env, PATH: path }, cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(describeFailure(bin, args, env, error, stdout, stderr, timeoutMs)));
      else resolve(stdout);
    });
  });
}
