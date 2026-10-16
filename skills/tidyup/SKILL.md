---
name: tidyup
description: "Measure and reclaim disk space on a macOS development machine. Use when the user asks why the disk is full or wants to free space, or mentions cleaning build output or caches (Rust target/, Docker, npm/pnpm/uv/Go caches, agent temp dirs). This includes Korean requests such as \"용량 정리\" or \"디스크 꽉 찼어\", and scheduled checks that report low headroom. Scans are read-only; deletion happens only for items the user selects by ID."
---

# tidyup

tidyup measures disk headroom and lists cleanup candidates with evidence. It
deletes only the items the user selects.

> **Status: v1 in progress.** Only Rust build output (`rust-target`) is
> detected so far. For other space users (Docker, package caches, temp clones,
> agent scratch), investigate manually. Show the user what you find, and delete
> nothing without their explicit approval.

## Running

Invoke the launcher by its absolute path inside this skill directory:

```sh
<skill-dir>/scripts/tidyup scan
```

The launcher needs Node.js 22 or newer. It looks in `$TIDYUP_NODE` first, then
`PATH`, then `mise which node`. If it reports that Node is missing, ask the user
for the Node path and pass it as `TIDYUP_NODE`.

## Interactive workflow

1. **Scan.** Run `scan`. Use `scan --deep` when the user wants candidates even
   though headroom is `ok`. Add `--root <dir>` for project directories outside
   the default locations (`~/code`, `~/src`, `~/Developer`, `~/projects`,
   `~/_GIT`, `~/git`, `~/work`).
2. **Present.** Show the headroom line and the candidate table. Say that sizes
   are estimates and that actual freed space can be lower. Explain each class:
   - `routine` items regenerate on the next build or download.
   - `review` items may hold unique work.
   - `judgment` items are for the user alone to decide.
3. **Ask.** Ask which IDs to delete. You may recommend routine items, but wait
   for the user to choose.
4. **Apply.** Run `apply <id>...` with the same `--root` options as the scan.
   Report each outcome (`deleted`, `refused`, `failed`) and the headroom change.
   A `refused` item was not deleted because it no longer qualified. Do not work
   around a refusal with other commands.

## Scheduled workflow

Unattended runs call only `scan --json`, never `apply`.

- **Exit code:** the level. 0 means `ok`, 10 `recommend`, and 20 `urgent`; 1
  means the scan failed. Read stdout for every exit code.
- **When to report:** when the level, the `fingerprint`, or the `skipped` list
  changed since the previous run.
- **Empty `items`:** when `candidates_measured` is `false`, an empty list means
  the candidates were not measured, not that nothing was found.

## Safety rules

- `scan` is read-only.
- Pass `--reviewed <id>` only for IDs that the user named in this conversation
  after seeing their evidence. Never generate it on your own.
- Judgment items have no ID. Never delete them with other commands either.
