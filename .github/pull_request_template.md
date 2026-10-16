<!--
Write the title and body in English. Use a Conventional Commit title, e.g. `feat(detectors): add the Rust target detector`.
Keep tracker identifiers in the history section rather than branch names or commit subjects.
Target dev; prepare independently understandable commits for rebase integration and fast-forward promotion.
Follow CONTRIBUTING.md. Remove instructional comments, empty placeholders, and inapplicable optional sections.
Check only completed, applicable items; mark others N/A with a reason or remove them.
-->

## Summary

<!-- Explain the problem and resulting behavior in one short paragraph. -->

## Scope & non-goals

<!-- State the included work and relevant boundaries. -->

## Type of change

- [ ] Feature (`feat`)
- [ ] Fix (`fix`)
- [ ] Refactor (`refactor`)
- [ ] Performance (`perf`)
- [ ] Chore / build / tooling (`chore`, `build`)
- [ ] CI (`ci`)
- [ ] Docs (`docs`)
- [ ] Tests (`test`)
- [ ] Revert (`revert`)

## What changed

<!-- One bullet per affected area; explain what a reviewer should inspect. -->

-

## Key decisions

<!-- Record significant decisions and their reasons. Omit for a mechanical change. -->

## Verification

<!-- List actual commands and outcomes: `sh -n skills/tidyup/scripts/tidyup`, `npm test`, and whitespace checks.
Keep local tests, hosted CI, live macOS runs, and installation evidence separate. State unperformed checks.
-->

- [ ] Applicable syntax and whitespace checks pass
- [ ] `npm test` passes; changed behavior has deterministic regression coverage
- [ ] Live macOS run verified where affected, with macOS and Node versions recorded

## Risks & rollback

<!-- Remove for documentation-only or other changes without runtime or distribution impact.
For externally visible contract changes (CLI options, JSON output, exit codes), include the applicable line:
Boundary classification: unreleased — corrected in place.
Boundary classification: released — compatibility required because <specific consumer or stored state>.
-->

- **Deletion safety:** <!-- Could this change delete something it should not, or skip a re-check? -->
- **Recovery:** <!-- How to recover; consider installed copies and symlinked checkouts. -->
- **Breaking changes:** none <!-- Or identify the exact affected contract and consumers. -->
- **Environment / permissions:** none <!-- Or describe affected paths, TCC, or sandbox behavior. -->

## Pre-integration checklist

- [ ] Self-reviewed the complete diff; no leftover debug code or unrelated changes
- [ ] Applicable checks are reproducible from a clean checkout
- [ ] No secrets, personal paths, or real scan output committed; fixtures are synthetic
- [ ] README, SKILL.md, and docs/design.md updated where affected
- [ ] Branch is current with `dev`; commits are ready for rebase integration

## Repository authority and history (optional)

<!-- Link repository-owned contracts, evidence, decisions, and relevant prior PRs or issues.
Use Refs #123 for related work on a PR targeting dev; closing keywords do not close issues on dev merge.
-->

-
