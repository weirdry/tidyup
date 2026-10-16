# Contributing to tidyup

This document defines tidyup's branch, commit, review, validation, and release
rules.

## Working language

Write repository documentation, commit messages, issue titles and bodies, pull
requests, comments, and status updates in English. When quoting code,
identifiers, or diagnostic output as evidence, keep it exact and explain it in
English.

## Branch strategy

tidyup uses a simplified Gitflow model with linear integration and release
history.

| Branch | Role |
| --- | --- |
| `main` | Validated release branch and the source for distribution |
| `dev` | Development and integration branch for the next release; no deployment target |
| Work branches | Isolated feature, fix, refactoring, documentation, test, or maintenance work |

All changes reach `main` through promotion from `dev`. Do not implement changes
directly on `main` unless the maintainer explicitly directs an exception.

## Direct development or a pull request

Direct commits to `dev` are allowed. They often suit small fixes, documentation,
and routine maintenance.

Use a dedicated work branch and a pull request when a change is substantial,
risky, benefits from review, or should be discussed on its own. Start work
branches from the latest `origin/dev` and target `dev` for integration PRs.

Name branches by purpose with a prefix: `feature/`, `fix/`, `refactoring/`,
`perf/`, `docs/`, `test/`, or `chore/`. For example, `feature/rust-target-detector`.
Keep issue numbers in the PR body, not in branch names or commit subjects.

## Issue management

[GitHub Issues](https://github.com/weirdry/tidyup/issues) are the source of truth
for development and maintenance work. Issues own the agreed scope, acceptance
criteria, ownership, and progress. Repository documents and executable evidence
own the technical facts.

- **Before creating:** search existing issues and reuse one that tracks the same
  outcome. A small, self-contained correction can be explained in its commit or
  PR without an issue.
- **Template:** use the repository-local [work template](.github/ISSUE_TEMPLATE/work.md)
  for every work type, whether you write in the web UI, the CLI, or the API. Keep
  its five headings: Purpose, Work, Acceptance criteria, Out of scope, and
  References. Use `N/A` with a short reason where a section does not apply.
- **While working:** keep the body current. Check off completed work and link
  design and validation evidence under References.
- **Structure:** use native sub-issues when parts need their own owner, status,
  or acceptance criteria, and checkboxes for steps within one task.
- **Linking:** a PR targeting `dev` links its issue with `Refs #123`. Closing
  keywords take effect only for PRs targeting the default branch.
- **Closing:** close an issue after its acceptance criteria are met, with links
  to the supporting PRs or commits. Close canceled or duplicate work with the
  reason.

GitHub shows issue templates from the default branch, `main`. A template added
on `dev` reaches the web chooser after the next promotion.

## Commit messages

Every commit follows Conventional Commits:

```text
type(scope): imperative summary

Explain the resulting behavior and why it is needed, plus details the diff
does not show.
```

The scope is optional. When present, use a short, lowercase, kebab-case name
such as `tidyup`, `scripts`, `detectors`, `tests`, `docs`, `ci`, or `repo`.

| Type | Use |
| --- | --- |
| `feat` | New user- or consumer-facing capability |
| `fix` | Bug fix |
| `docs` | Documentation-only change |
| `refactor` | Internal restructuring without a behavior change |
| `test` | Test-only change |
| `build` | Build, dependency, or packaging change |
| `ci` | CI configuration change |
| `chore` | Repository maintenance not covered by another type |
| `perf` | Performance improvement |
| `revert` | Reversion of an earlier commit |

For a breaking contract change, put `!` after the type or scope and explain the
break in a `BREAKING CHANGE:` footer. Keep commits focused and understandable on
their own.

## Development setup and validation

Development needs macOS, Node.js 22 or newer, and the POSIX utilities that the
scripts call. There are no dependencies to install.

Run the checks from the repository root before committing:

```sh
sh -n skills/tidyup/scripts/tidyup
npm test
git diff --check
git diff --cached --check
```

[Hosted CI](.github/workflows/ci.yml) runs the same checks on macOS with the
minimum and the current LTS Node versions.

Testing rules:

- Tests use synthetic fixtures in temporary directories.
- Never run `apply` against a real home directory as a test technique.
- Add deterministic regression tests for changed detector or deletion behavior.
- Record a live macOS run separately from tests: the macOS and Node versions,
  the command, and the outcome. Report each kind of evidence separately: local
  checks, hosted CI, live runs, and installation.

## Direct commits to dev

```sh
git switch dev
git pull --ff-only origin dev

# Make the scoped change and run the checks above.
git add <changed-paths>
git commit
git push origin dev
```

Stage only the intended change. Do not force-push `dev` or `main`.

## Pull request workflow

1. Fetch and create a work branch from `origin/dev`.
2. Make focused changes with Conventional Commits.
3. Rebase onto updated `origin/dev` when needed and rerun the checks.
4. Push the work branch and open a PR targeting `dev`.
5. Complete the repository-local [PR template](.github/pull_request_template.md).
6. Finish review and the required checks.
7. Integrate with rebase merge.

```sh
git fetch origin
git switch -c feature/rust-target-detector origin/dev

# Later, to synchronize before review:
git fetch origin
git rebase origin/dev
```

Do not merge `dev` into a work branch. Do not use merge commits or squash merge.
When rewriting an already-pushed work branch, use `--force-with-lease`.

PR title and body:

- Write them in English, with a Conventional Commit title.
- List actual verification commands and outcomes.
- Check only completed, applicable items. Mark other items `N/A` with a reason.
- Remove instructional comments and empty placeholders.

## Promoting dev to main and releasing

Promotion is fast-forward only:

```sh
git switch dev
git pull --ff-only origin dev

# Run the checks above.

git switch main
git pull --ff-only origin main
git merge --ff-only dev
git push origin main
git switch dev
```

If a fast-forward fails, stop and resolve the divergence deliberately. Do not
replace `--ff-only` with a merge commit or a force push.

A release is an annotated tag on a promoted `main` commit:

1. Move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under the new
   version on `dev`, and promote.
2. Tag `main`: `git tag -a vX.Y.Z -m "tidyup vX.Y.Z"` and
   `git push origin vX.Y.Z`.
3. Create the GitHub release from that tag with its changelog section.

Published tags are immutable; a correction gets a new version. The README's
install command names the newest verified tag.

## Release boundaries and installed state

Existing installations are real consumers. This includes copies installed by
the Skills CLI and symlinks to a development checkout. A symlink loads its target
immediately, so a branch switch or rebase affects any session that uses it. Use
a separate worktree for development when an installed symlink points at this
checkout.

Commits on `dev` since the last promotion are unreleased. Evolve them in place
without version chains or migrations. For an externally visible contract change,
such as CLI options, JSON output, or exit codes, include one of these lines in
the PR description:

- `Boundary classification: unreleased — corrected in place.`
- `Boundary classification: released — compatibility required because <specific consumer or stored state>.`

## Documentation and evidence

| Document | Owns |
| --- | --- |
| [skills/tidyup/SKILL.md](skills/tidyup/SKILL.md) | The agent workflow |
| [docs/design.md](docs/design.md) | The behavioral contract and accepted targets |
| `skills/tidyup/scripts/` and `tests/` | Executable behavior |
| [README.md](README.md) | The user-facing overview and installation |
| This document | Contribution procedures |

Update the affected documents together when behavior changes. Distinguish
implemented behavior from accepted targets.

Fixtures in Git are synthetic. Keep real paths, usernames, project names, and
scan outputs from personal machines out of commits.

### Agent entry documents

[RULES.md](RULES.md) is the single source of repository-wide agent instructions.
[AGENTS.md](AGENTS.md) directs agents to read it, and [CLAUDE.md](CLAUDE.md)
imports it with `@RULES.md`. Keep both entry documents to one line.
