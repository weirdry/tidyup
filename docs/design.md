# tidyup design

Status: accepted v1 target. Nothing described here is implemented yet; the
[CHANGELOG](../CHANGELOG.md) records what has shipped.

## Purpose

Developer Macs fill up with data that is safe to rebuild: build output, container
build caches, package caches, and agent scratch space. tidyup measures disk
headroom, explains which items can be removed and why, and deletes only the items
a user selects. It is an agent skill first: Claude Code, Codex, and scheduled
agent tasks call the same script and follow the same skill instructions.

## Scope

- **Platform:** macOS only. On any other platform the script prints
  "tidyup supports macOS only" and exits with an error. Each detector records its
  platform, so Linux can be added later without a platform abstraction layer.
- **Runtime:** Node.js 22 or newer, ES modules, no dependencies.
- **Callers:**
  - interactive agent sessions;
  - scheduled agent tasks, such as a Codex scheduled task or a ChatGPT dot that
    creates a Codex local task. Scheduled callers only run `scan`.

## Runtime and launcher

`skills/tidyup/scripts/tidyup` is a POSIX `sh` launcher. It resolves Node in this
order, validates that the major version is at least 22, and execs
`tidyup.mjs` with the original arguments:

1. `$TIDYUP_NODE`. If it is set but invalid, the launcher fails and does not fall
   through to the next step.
2. `node` on `PATH`.
3. `mise which node`, when `mise` is available. The launcher never installs
   anything and never sources shell profiles.

If no suitable Node is found, the launcher exits with a setup message. A skill
installation does not guarantee that Node is on the `PATH` of GUI apps or
scheduled tasks, so scheduled callers should invoke the launcher by absolute path.

## Headroom

Free space comes from `fs.promises.statfs($HOME)`:

- available = `bavail × bsize`
- total = `blocks × bsize`

On macOS this is normally the Data volume. The report names the measured path.

| Level | Condition | Exit code |
| --- | --- | --- |
| `ok` | available > 20% of total | 0 |
| `recommend` | available ≤ 20% | 10 |
| `urgent` | available ≤ 10% | 20 |

## Measurement

- Item sizes come from `du -sk` with absolute operands and `LC_ALL=C`. That
  avoids parsing option-like names such as `-Users-...`.
- APFS clones and hard links mean that sizes overlap. Sizes are labelled as
  estimates, and the sum is never presented as guaranteed reclaimable space.
- Detailed measurement runs when the level is `recommend` or worse, or when the
  caller passes `--deep`. At `ok` without `--deep`, a scan reports only headroom.
- A detector that cannot run is listed under `skipped` with a reason. The scan
  continues without it. Typical reasons are a missing CLI, a stopped daemon, a
  permission denial (TCC or sandbox), or a timeout.

## Item classes

| Class | Meaning | Deletion |
| --- | --- | --- |
| `routine` | Regenerable by rebuilding or re-downloading | `apply <id>` |
| `review` | May hold unique work | Only with `--reviewed <id>`, after the user has seen the evidence and named the ID |
| `judgment` | User data or expensive to recreate | Never; listed with size only and no ID |

Scheduled and other unattended callers never pass `--reviewed`. The skill
instructions forbid generating it without explicit user authorization in the
conversation.

## v1 detectors

| Detector | Class | Selection | Removal |
| --- | --- | --- | --- |
| `rust-target` | routine | `target/` next to a `Cargo.toml` under project roots, idle 14 days | remove directory |
| `docker-build-cache` | routine | build cache older than 7 days | `docker builder prune --force --filter until=168h`, evaluated at apply |
| `docker-dangling-images` | routine | dangling images | `docker image prune --force` |
| `docker-unused-images` | review | tagged images used by no container | `docker rmi <image-id>` |
| `npm-cache`, `pnpm-store`, `uv-cache`, `go-build-cache`, `go-mod-cache` | routine | cache present | the tool's own command: `npm cache clean --force`, `pnpm store prune`, `uv cache prune`, `go clean -cache`, `go clean -modcache` |
| `agent-scratch` | review | Claude Code session temp dirs (`/private/tmp/claude-<uid>/<project>/<session>`) idle 7 days. Codex locations are confirmed during implementation | remove directory |
| `temp-clones` | review | git work trees under temp roots idle 7 days | linked worktrees: `git worktree remove`; others: remove directory |
| `docker-volumes`, `model-caches`, `app-containers`, `homebrew` | judgment | sizes only | none |

Project roots are discovered from common locations: `~/code`, `~/src`,
`~/Developer`, `~/projects`, `~/_GIT`, `~/git` and `~/work`, plus `--root` options.
Idle means no file in the subtree was modified within the window.

Review items carry evidence:

- git facts: dirty or ignored files, commits not reachable from a
  remote-tracking ref, stash, and linked-worktree status;
- the newest mtime in the subtree.

Session ownership is shown as `unknown` unless specific evidence establishes it.
tidyup does not infer that a session has ended.

## Item IDs and `apply`

IDs are `<detector>:<short hash of realpath>`. Docker items use the image ID.
`apply` then:

1. re-runs the owning detectors for the requested IDs only;
2. refuses any ID that is missing or no longer eligible;
3. refuses any root that is a symlink, and any realpath that falls outside the
   detector's root;
4. performs the removal, never with `sudo`;
5. reports one outcome per item: `deleted`, `refused (reason)`, or
   `failed (reason)`.

`apply` checks current eligibility. It does not prove that nothing changed since
the preview. A directory replaced in place between the two runs is a documented
residual race and is not engineered away.

## Output

The default output is a human-readable table. `--json` emits the following
object:

```json
{
  "host": "…",
  "measured_path": "/Users/…",
  "total_bytes": 0,
  "available_bytes": 0,
  "available_percent": 0,
  "level": "ok|recommend|urgent",
  "items": [
    {
      "id": "…",
      "class": "routine|review|judgment",
      "detector": "…",
      "path": "…",
      "estimated_bytes": 0,
      "evidence": {}
    }
  ],
  "skipped": [{ "detector": "…", "reason": "…" }],
  "fingerprint": "…"
}
```

The tool is stateless. `fingerprint` is a deterministic hash of the eligible
item IDs, so callers can deduplicate notifications. A scheduled caller typically
compares host, level, fingerprint, and skipped set with its previous run.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0, 10, 20 | Headroom level, as in the table above |
| 1 | Error, including setup failure, or `apply` with any refused or failed item |
| 2 | Usage error |

Callers must read stdout even for exit codes 10 and 20.

## Deferred

- Homebrew cleanup through `apply`. `brew cleanup` also removes old installed
  formula versions, which is outside package-cache scope.
- A configuration file. CLI options and auto-discovery come first; add an XDG
  path such as `~/.config/tidyup/` only when a real need appears.
- Linux support.
- Session-owner inference and Docker image provenance analysis.

## Conventions followed

- Preview by default and deletion by explicit selection, as in
  [cargo-sweep](https://github.com/holmgr/cargo-sweep) and
  [npkill](https://github.com/voidcosmos/npkill).
- Dangling images only by default, with broader removal opt-in, as in
  [`docker image prune`](https://docs.docker.com/reference/cli/docker/image/prune/).
