# tidyup design

Status: accepted v1 target, implemented incrementally under
[#2](https://github.com/weirdry/tidyup/issues/2). The [CHANGELOG](../CHANGELOG.md)
records what is implemented.

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

## Commands

```text
tidyup scan [--deep] [--root <dir>]... [--json]
tidyup apply <id>... [--reviewed <id>]... [--root <dir>]... [--json]
```

IDs come from detection over the project roots, so `apply` must receive the
same `--root` options as the `scan` that produced them.

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
- Idle checks run `find <path> -newermt <cutoff> -print -quit` with the cutoff
  and `TZ` both in UTC, so DST transitions cannot shift the window.
- A detector that cannot run is listed under `skipped` with a reason. The scan
  continues without it. The same applies to a directory that cannot be read
  during discovery. Typical reasons are a missing CLI, a stopped daemon, a
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
| `rust-target` | routine | `target/` next to a `Cargo.toml` under project roots, idle 14 days. The search goes at most 4 levels deep and skips hidden directories, `node_modules`, and `target`. A Cargo marker is required: a `CACHEDIR.TAG` with the Cargo signature, or a `<profile>/.fingerprint` directory (some front ends, such as maturin, omit the tag) | remove directory |
| `docker` (build cache) | routine | build cache records last used more than 7 days ago, excluding shared and in-use records | `docker builder prune --force --filter until=168h`, evaluated at apply |
| `docker` (dangling images) | routine | dangling images used by no container | `docker image prune --force` |
| `docker` (unused images) | review | tagged images used by no container, including stopped containers; one item per image | `docker image rm <ref>` for each tag |
| `docker` (volumes) | judgment | all volumes as one item; the largest are listed in evidence | none |
| `caches` (npm, pnpm, uv, Go build, Go modules) | routine | a cache directory reported by the tool exists | the tool's own command: `npm cache clean --force`, `pnpm store prune`, `uv cache clean`, `go clean -cache`, `go clean -modcache` |
| `agent-scratch` | review | Claude Code session temp dirs (`/private/tmp/claude-<uid>/<project>/<session>`, also under `$TMPDIR`) idle 7 days, unless the session transcript was modified within 7 days | `git worktree remove` for linked worktrees inside, then remove the directory |
| `temp-clones` | review | top-level entries of `/private/tmp`, `$TMPDIR`, and `~/.codex/worktrees` that contain a git work tree within 3 levels, idle 7 days; agent scratch roots are excluded | `git worktree remove` for linked worktrees inside, then remove the directory |
| `model-caches`, `app-containers`, `homebrew` | judgment | sizes only | none |

The `docker` detector uses the docker CLI, so it works with any runtime: Colima,
Docker Desktop, or OrbStack.

- **Data sources:** sizes and container counts come from `docker system df -v`,
  and the full tag sets from `docker image ls`. `system df` shows only an image's
  first tag.
- **Unknown container counts:** images whose count is unknown (`N/A`) are
  reported under `skipped` and are never candidates.
- **CLI location:** `$TIDYUP_DOCKER`, then `PATH`, then the Homebrew and Docker
  Desktop locations. An invalid `$TIDYUP_DOCKER` is an error.
- **Endpoint pinning:** each operation pins the docker context it started with
  by passing `--context`, unless `DOCKER_HOST` already pins the endpoint.
- **No Docker installed:** the detector is silently absent.
- **Daemon unreachable:** reported under `skipped`.
- **Before removing any Docker item:** `apply` confirms the daemon ID is
  unchanged. For images, it also confirms the tags are unchanged and that no
  container uses the image.

The `caches` detector asks each tool where its cache is: `npm config get
cache`, `pnpm store path`, `uv cache dir`, `go env GOCACHE`, and
`go env GOMODCACHE`. It runs these commands from the home directory, so a
project's `.npmrc` or `uv.toml` does not apply.

Cleaning always goes through the tool's own command, aimed at the located cache:

- npm: `--cache`;
- uv: `--cache-dir`;
- Go: `GOCACHE` / `GOMODCACHE`, with `GOENV=off` and an empty `GOFLAGS`, so that
  inherited flags such as `-modcache` cannot widen `go clean`.

Right before cleaning, `apply` refuses if the tool now reports a different
location. tidyup never deletes a tool's cache directory itself. A cache path
that cannot be inspected (for example EACCES) is reported under `skipped`.

- **pnpm:** `pnpm store prune` removes only unreferenced packages and has no dry
  run, so the store size is reported as evidence and the estimate is unknown.
  pnpm's default import method (`auto`) clones files into `node_modules` where
  the filesystem supports it (APFS does), and otherwise hard-links them. Either
  way the store's data stays shared, so deleting the whole store would often
  free little.
- **uv:** uses `uv cache clean`. `uv cache prune` removes only unreachable
  entries and cannot preview its effect. Everything `clean` removes is
  re-downloadable. With uv's default link mode on macOS (`clone`), installed
  environments keep their data.
  - With link mode `symlink`, environments point into the cache. If `symlink`
    appears anywhere in the global configuration, the item becomes a review item
    with a warning. The global configuration means `UV_LINK_MODE`, plus any
    `link-mode` value in the global config files: `UV_CONFIG_FILE`, or else the
    user and system `uv.toml`, in any section or inline table such as `[pip]`.
  - A relative `UV_CONFIG_FILE` resolves against the home directory, where uv
    runs. An unreadable one also makes the item a review item.
  - Project-level link-mode settings are not inspected.

External CLIs (docker and the package tools) are found on `PATH`, then in common
install locations: Homebrew, `~/.local/bin`, mise shims, and tool-specific
directories. They run with the running Node's directory first on `PATH`, so
Node-based CLIs work from GUI apps and scheduled tasks. A tool that is not
installed is silently absent.

Project roots are discovered from common locations: `~/code`, `~/src`,
`~/Developer`, `~/projects`, `~/_GIT`, `~/git` and `~/work`, plus `--root` options.
Idle means no file in the subtree was modified within the window.

Review items carry evidence, plus a one-line `evidence.summary` shown under the
scan table. A candidate is picked when a git work tree exists within 3 levels.
Evidence and removal then cover every work tree in the whole item, including
ones nested inside another repository. They are found with NUL-framed `find`
output, so a name containing a newline cannot be misread as another path.

Git decides which work trees are linked worktrees: those whose git dir differs
from the repository's common dir. A submodule's `.git` file points into its
superproject, so a submodule is not treated as a linked worktree. For each git
work tree inside the item, the evidence lists:

- changed and untracked entries, and ignored entries;
- `only_here`: commits that removal would lose.
  - For a standalone clone, these are commits on HEAD, branches, or tags that
    no remote-tracking ref has.
  - For a linked worktree, they are commits on its HEAD that no branch, tag,
    or remote has. Its branches live in the shared repository and survive.
- stashes. A linked worktree shares its stashes with its repository, so they
  are not counted for it.
- whether it is a linked worktree;
- an error when git cannot read it. Unreadable trees are named in the summary,
  never counted as zeros.

Agent scratch items also record the session transcript
(`~/.claude/projects/<project>/<session>.jsonl`) when one exists.

- **Timing:** the transcript is read once, as the last step of evaluation. A
  transcript modified within the idle window makes the session ineligible.
- **Ownership:** otherwise session ownership is shown as `unknown`; tidyup does
  not infer that a session has ended.
- **Failures:** a root, subtree, or transcript that cannot be read (anything
  other than absence) is reported under `skipped`, and the item is not offered.

Safety rules for these directories:

- **Ownership:** only directories owned by the current user are considered.
  `/tmp` is writable by every user, and running git inside another user's
  repository could execute that repository's configuration.
- **No redirection:** git runs with inherited `GIT_*` variables removed, so
  `GIT_DIR` or `GIT_WORK_TREE` cannot point the evidence elsewhere.
- **No repository commands:** git runs with `core.fsmonitor` disabled, so a
  repository's configured monitor command never runs during a scan.
- **No index refresh:** evidence commands use `--no-optional-locks`, so a scan
  does not refresh the index and make an idle tree look recently modified.
- **Removal order:**
  1. Every linked worktree inside the item, nested ones included, is removed
     deepest first with `git worktree remove` and without `--force`. A worktree
     with changes or untracked files stops the removal.
  2. If the item itself was a linked worktree, git has already removed it.
     Only absence counts as removed; any other failure to inspect the path is
     an error.
  3. Otherwise the path is checked again (containment, no symlink).
  4. Read-only directories, such as Go module caches, are made owner-writable,
     and the directory is deleted.

## Item IDs and `apply`

IDs are `<detector>:<short hash>`. For filesystem items the hash covers the
realpath. For Docker items it covers the daemon ID and the item kind, plus the
image ID and its tags for images. An ID therefore never applies to another
daemon, and approving an image never extends to tags added after the scan.
Each detector separates cheap *discovery* of candidate locations from the
*evaluation* of whether a candidate qualifies now. `apply` then:

1. re-discovers candidates with the owning detectors, then handles each
   requested ID in turn;
2. refuses an ID that is not discovered, a symlink, or a realpath outside the
   detector's roots;
3. evaluates that item's eligibility and removes it immediately if it still
   qualifies, never with `sudo`. No other item's checks run in between;
4. reports one outcome per item: `deleted`, `refused (reason)`, or
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
  "candidates_measured": true,
  "items": [
    {
      "id": "…",
      "class": "routine|review|judgment",
      "detector": "…",
      "path": "… (filesystem items)",
      "label": "… (other items, e.g. Docker)",
      "estimated_bytes": 0,
      "evidence": {}
    }
  ],
  "skipped": [{ "detector": "…", "reason": "…" }],
  "fingerprint": "…"
}
```

`candidates_measured` is `false` when detectors did not run, at `ok` without
`--deep`. An empty `items` list then means "not measured", not "nothing found".

The tool is stateless. `fingerprint` is a deterministic hash of the eligible
item IDs, so callers can deduplicate notifications. A scheduled caller typically
compares host, level, fingerprint, and skipped set with its previous run.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0, 10, 20 | `scan`: headroom level, as in the table above |
| 0 | `apply`: every requested item was deleted |
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
