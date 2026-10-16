# Working in tidyup

This file is the single source of repository-wide agent instructions. Maintain
shared rules here; keep tool-specific entry documents as references to this file.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before substantive repository changes.
Use the repository-local [PR template](.github/pull_request_template.md) when
opening or substantially updating a pull request.

- Follow the documented `dev` integration and fast-forward `main` promotion flow.
- Manage tidyup development and maintenance through GitHub Issues. Follow the
  [issue workflow](CONTRIBUTING.md#issue-management) and use the repository-local
  [work template](.github/ISSUE_TEMPLATE/work.md) when creating or updating issues.
- Write repository documentation, commit messages, issues, pull requests, comments,
  and status updates in English, following the
  [working language policy](CONTRIBUTING.md#working-language).
- Read the [design](docs/design.md), the affected skill instructions, scripts, and
  tests together before changing behavior.
- Deletion safety is the core contract. `scan` never deletes. `apply` deletes only
  user-selected routine or review items after re-checking them. Never give
  judgment items an ID.
- Never run `apply` against a real home directory as a test technique. Tests use
  synthetic fixtures in temporary directories.
- Keep local tests, hosted CI, live macOS runs, and installation evidence
  distinct. Record what remains unverified.
- Classify compatibility needs using actual installed consumers and stored state.
  Avoid speculative compatibility layers.
- Prefer established conventions from comparable tools over new machinery, and
  avoid over-engineering.
