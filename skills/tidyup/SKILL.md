---
name: tidyup
description: "Measure and reclaim disk space on a macOS development machine. Use when the user asks why the disk is full or wants to free space, or mentions cleaning build output or caches (Rust target/, Docker, npm/pnpm/uv/Go caches, agent temp dirs). This includes Korean requests such as \"용량 정리\" or \"디스크 꽉 찼어\", and scheduled checks that report low headroom. Scans are read-only; deletion happens only for items the user selects by ID."
---

# tidyup

tidyup measures disk headroom and lists what can be cleaned. Every item comes
with evidence, and tidyup deletes only the items the user selects.

## Running

Invoke the launcher by its absolute path inside this skill directory:

```sh
<skill-dir>/scripts/tidyup scan
```

The launcher needs Node.js 22 or newer. It looks in `$TIDYUP_NODE` first, then
`PATH`, then `mise which node`. If it reports that Node is missing, ask the user
for the Node path and pass it as `TIDYUP_NODE`.

## Item classes

- **routine:** regenerates on the next build, pull, or download. Examples are
  Rust `target/`, Docker build cache, dangling images, and package caches.
- **review:** may hold unique work. Examples are temp clones, agent session
  scratch, and unused tagged Docker images. The scan prints a "Review evidence"
  line for each.
- **judgment:** user data or costly to recreate. Examples are Docker volumes,
  the Hugging Face model cache, leftover data of uninstalled apps, and Homebrew
  cleanup. These have no ID, and tidyup never deletes them.

## Interactive workflow

1. **Scan.** Run `scan`.
   - Use `scan --deep` when the user wants to see candidates even though
     headroom is `ok`.
   - Add `--root <dir>` for project directories outside the defaults: `~/code`,
     `~/src`, `~/Developer`, `~/projects`, `~/_GIT`, `~/git`, and `~/work`.
2. **Present.** Show:
   - the headroom line;
   - the candidate table;
   - the "Review evidence" lines;
   - the "Judgment items" lines.

   Sizes are estimates, and actual freed space can be lower. For review items,
   point out changed files, commits "only here", and stashes: removal loses them.
3. **Ask.** Ask which IDs to delete. You may recommend routine items; wait for
   the user to choose.
4. **Apply.** Run `apply <id>...` with the same `--root` options as the scan.
   Pass review IDs the user named with `--reviewed <id>`. Report each outcome
   (`deleted`, `refused`, `failed`) and the headroom change.
   - A `refused` item no longer qualified, and a `failed` item hit an error;
     neither was deleted. Do not work around either with other commands.
5. **Judgment items.** Explain what each one is, using its evidence. Remove one
   only when the user explicitly asks for that specific item. Then follow
   `evidence.hint`, the tool's own command or Finder, and confirm the exact
   command before running it.

## Scheduled workflow

Unattended runs call only `scan --json`, never `apply`.

- **Exit code:** the level. 0 is `ok`, 10 is `recommend`, 20 is `urgent`, and 1
  means the scan failed. Read stdout for every exit code.
- **When to report:** compare with the previous run, and report when the level,
  the `fingerprint`, or the `skipped` list changed.
- **Empty items:** when `candidates_measured` is `false`, an empty `items` list
  means the candidates were not measured, not that nothing was found.

## Safety rules

- `scan` is read-only.
- Pass `--reviewed <id>` only for IDs that the user named in this conversation
  after seeing their evidence. Never generate it on your own.
- Never delete judgment items unless the user explicitly asks for that item.
