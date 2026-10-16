# tidyup

An agent skill that keeps **disk headroom** on macOS development machines.

Build output, container build caches, package caches, and agent scratch space
quietly fill a developer's disk. tidyup measures free space, explains which items
are safe to rebuild and why, and deletes only the items you select. Claude Code,
Codex, and scheduled agent tasks use the same script and instructions.

> **Status: under development.** No release exists yet. The accepted v1 behavior
> is described in [docs/design.md](docs/design.md). This README describes the
> target until the first release.

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
  - **judgment** items are listed with their size only and are never deleted:
    Docker volumes, model caches, and leftover app data.
- **`apply <id>…` deletes only what you selected.** It re-checks each item first
  and reports one outcome per item.
- **Scheduled callers can run it.** `scan --json` is stateless and returns the
  level as its exit code. A scheduled agent can report changes in headroom and
  never deletes.

## Requirements

- macOS
- Node.js 22 or newer. The launcher finds it via `$TIDYUP_NODE`, `PATH`, or
  `mise`.

## Installation

There is no release yet. For development, link a checkout into the skill
directories:

```sh
ln -s /absolute/path/to/tidyup/skills/tidyup ~/.agents/skills/tidyup
ln -s /absolute/path/to/tidyup/skills/tidyup ~/.claude/skills/tidyup
```

After the first release, install a tagged version with the
[Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add 'weirdry/tidyup#vX.Y.Z' -g -a codex claude-code
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
