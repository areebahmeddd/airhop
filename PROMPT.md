# Airhop Contribution Prompt

## 1. Core Implementation

I'm contributing to Airhop and have picked up an issue.

Read [`VISION.md`](docs/design/VISION.md), [`ARCHITECTURE.md`](docs/spec/ARCHITECTURE.md), [`PROTOCOLS.md`](docs/spec/PROTOCOLS.md), [`PROGRESS.md`](docs/dev/PROGRESS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) to understand the project, its non-negotiables, and its conventions. If the issue touches a specific subsystem, also read the matching file in [`.github/skills/`](.github/skills/). Get the project running and its checks passing: `npm install`, then `npm run typecheck && npm run lint && npm test`.

**Issue:** [link]

Analyze the issue, trace it to the actual code path, and cross-check the surrounding code and its callers. Implement a clean, correct solution that fits the existing codebase, its architecture, and its conventions, per the docs above. Think it through and approach it confidently and smartly, with good engineering judgment.

---

## 2. Post-Implementation Review

Step back and review the change against the issue and the surrounding codebase flow.

- Verify the core issue is actually addressed, not just the immediate symptom.
- Trace the relevant code paths and callers end to end, from the user's point of view: the normal scenario, then the chaos scenarios.
- Ensure the implementation is logical, coherent, clean, and internally consistent with `ARCHITECTURE.md`, following SOLID and sound system design principles as Airhop's own codebase applies them.
- Check for gaps, regressions, unnecessary complexity, or duplicated logic.
- Be balanced: do not over-engineer or overdo it. Prefer the simplest sound solution that fits the existing design.
- Review it the way you'd want a senior engineer to review it before it reaches production. Fix issues found within scope and avoid unrelated refactors.

---

## 3. Post-Code Cleanup

Review only the code changed within the current scope.

- Comments explain why, not what. Remove redundant comments and any changelog or history context.
- Keep comments only for non-obvious invariants, magic numbers, platform quirks, or intentional deviations.
- No em dashes, in code or docs. Write in proper, natural English grammar.
- Follow existing naming and file conventions, and correct any that don't hold up: variables, constants, and functions named per current industry and language-standard convention, files named per the project's own pattern. Do not introduce new conventions of your own.
- Keep the code production-ready, minimal, and idiomatic. Do not change behavior unless required to fix a clear issue.
- Run the full check suite and fix anything it surfaces:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run coverage
npm run i18n:audit -- --max 0
npm run i18n:native
npm run verify:invisibles
npm run verify:vendored
npm run deadcode
```

- Match the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) before opening the PR.
