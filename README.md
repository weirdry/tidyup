# tidyup

An agent skill that keeps **disk headroom** on macOS development machines.

Build output, container build caches, package caches, and agent scratch space
quietly fill a developer's disk. tidyup measures free space, explains which items
are safe to rebuild and why, and deletes only the items you select. Claude Code,
Codex, and scheduled agent tasks use the same script and instructions.

> **Status: v0.1.1.** The behavior is specified in [docs/design.md](docs/design.md),
> and changes are listed in the [changelog](CHANGELOG.md).

## How it works

- **`scan` never deletes.** It reports headroom as `ok`, `recommend` (≤ 20% free),
  or `urgent` (≤ 10% free), followed by candidates. Each candidate has a size
  estimate and the evidence for it.
- **Three classes:**
  - **routine** items can be regenerated: Rust `target/`, Docker build cache,
    dangling images, and package caches.
  - **review** items may hold unique work: temp clones, agent session scratch,
    and unused tagged images. They are deleted only after you see the evidence
    and name them.
  - **judgment** items are listed with their size, evidence, and a removal hint,
    and are never deleted: Docker volumes, the Hugging Face model cache,
    leftover data of uninstalled apps, and Homebrew cleanup.
- **`apply <id>…` deletes only what you selected.** It re-checks each item first
  and reports one outcome per item.
- **Scheduled callers can run it.** `scan --json` is stateless and returns the
  level as its exit code. A scheduled agent can report changes in headroom and
  never deletes.

## Usage

```sh
tidyup scan                 # headroom; candidates when ≤ 20% free
tidyup scan --deep          # candidates regardless of headroom
tidyup scan --json          # machine-readable; exit code 0/10/20 = ok/recommend/urgent
tidyup apply <id> [<id>...] # delete selected candidates after re-checking them
```

`tidyup` here means the skill's `scripts/tidyup` launcher. Agents run it as the
skill describes.

## Scheduled checks

`scan --json` is stateless, and its exit code is the headroom level, so any
scheduler can run it. Examples are a ChatGPT dot, a Codex scheduled task, cron,
and launchd. The caller remembers the previous result and decides when to speak
up. Scheduled runs must never call `apply`.

An example prompt for a scheduled agent:

```text
Every weekday at 10:00, run on my Mac: <skill-dir>/scripts/tidyup scan --json
Never run apply. Compare the result with your notes from the previous run,
matching host, level, fingerprint, and skipped. Message me only when:
- the level changed;
- the level is recommend and it is Monday;
- the level is urgent (every day).
Include headroom, the largest routine items, review items with their evidence
summaries, and anything under skipped.
```

## Requirements

- macOS
- Node.js 22 or newer. The launcher finds it via `$TIDYUP_NODE`, `PATH`, or
  `mise`.

## Installation

Install the released version for Codex and Claude Code with the
[Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills@1.7.2 add 'weirdry/tidyup#v0.1.1' -g -a codex claude-code
```

This installs the skill into `~/.agents/skills/tidyup`, which Codex reads, and
links it from `~/.claude/skills/tidyup` for Claude Code. Skills CLI 1.7.2 itself
needs Node.js 22.20 or newer; tidyup runs on any Node.js 22+.

For development, link a checkout instead:

```sh
ln -s /absolute/path/to/tidyup/skills/tidyup ~/.agents/skills/tidyup
ln -s /absolute/path/to/tidyup/skills/tidyup ~/.claude/skills/tidyup
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
