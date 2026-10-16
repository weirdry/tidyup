# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository foundation: contribution workflow, agent rules, v1 design, CI, and
  a skill skeleton whose launcher checks for macOS and Node.js 22+.
- `scan`:
  - measures headroom with `statfs` and classifies it as `ok`, `recommend`
    (≤ 20% free) or `urgent` (≤ 10% free);
  - prints a table, or JSON with `--json`;
  - returns the level as its exit code.
- The `rust-target` detector finds idle Cargo `target/` directories under the
  project roots.
- The `docker` detector works through the docker CLI with any runtime:
  - routine: build cache unused for 7+ days, and dangling images;
  - review: unused tagged images;
  - judgment: volumes.

  IDs are bound to the daemon, and image IDs also to their tags. Every
  operation pins the docker context it started with. Images whose container
  count is unknown are reported as skipped.
- The `caches` detector covers npm, pnpm, uv, and the Go build and module
  caches. It locates each cache by asking the tool from the home directory, and
  cleans it only with the tool's own command, aimed at the located cache.
  - Go cleaning ignores inherited `GOFLAGS` and go env settings.
  - The pnpm estimate is unknown, because prune removes only unreferenced
    packages.
  - A uv cache under `link-mode = symlink` becomes a review item.
- The `temp-clones` and `agent-scratch` detectors report directories that may
  hold unique work. These are temp entries containing git work trees, and
  Claude Code session scratch directories. Both are review items, and each
  carries git evidence: changed files, commits only here, stashes, and linked
  worktrees.
- Every review item carries a one-line evidence summary, shown under the scan
  table.
- `apply` deletes the selected items. For each item it re-checks the path and
  re-evaluates eligibility immediately before removing it, and it reports one
  outcome per item.
