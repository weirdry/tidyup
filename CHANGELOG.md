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
- `apply` deletes the selected items after a fresh detection and a path re-check,
  and reports one outcome per item.
