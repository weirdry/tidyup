---
name: tidyup
description: "Measure and reclaim disk space on a macOS development machine. Use when the user asks why the disk is full or wants to free space, or mentions cleaning build output or caches (Rust target/, Docker, npm/pnpm/uv/Go caches, agent temp dirs). This includes Korean requests such as \"용량 정리\" or \"디스크 꽉 찼어\", and scheduled checks that report low headroom. Scans are read-only; deletion happens only for items the user selects by ID."
---

# tidyup

> **Status: under development.** `scan` and `apply` are not implemented yet and
> exit with an error. If the user asks for disk cleanup, say so and investigate
> manually instead. Never delete anything without the user's explicit approval.

tidyup measures disk headroom and lists cleanup candidates with evidence. It
deletes only the items the user selects. The repository's `docs/design.md`
defines the full contract.

## Running

Invoke the launcher by its absolute path inside this skill directory:

```sh
<skill-dir>/scripts/tidyup --help
```

The launcher needs Node.js 22 or newer. It looks in `$TIDYUP_NODE` first, then
`PATH`, then `mise which node`. If it reports that Node is missing, ask the user
for the Node path and pass it as `TIDYUP_NODE`.

## Safety rules

- `scan` is read-only. Unattended or scheduled runs only ever call `scan`.
- Pass `--reviewed <id>` only for IDs that the user named in this conversation
  after seeing their evidence.
- Judgment items have no ID. Never delete them with other commands either.
