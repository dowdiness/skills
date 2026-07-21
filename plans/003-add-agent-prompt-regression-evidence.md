# Plan 003: Add deterministic prompt contracts and reproducible usage evidence

> **Executor instructions**: Implement deterministic checks only. Do not call
> models from `validate`, `test`, or CI. Do not claim static prompt checks are
> behavioral model evaluations.
>
> **Drift check (run first)**:
> `git diff --stat 6336d7b..HEAD -- scripts package.json README.md agents plans`
>
> This plan depends on the final prompt headings produced by Plans 001 and 002.
> Execute it only after those plans are stable in the same working tree or
> committed to HEAD.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-harden-operational-agent-prompts.md`, `plans/002-clarify-review-agent-contracts.md`
- **Category**: tests
- **Planned at**: commit `6336d7b`, 2026-07-21; current frontmatter state inspected

## Why this matters

Current validation proves that agent files exist, have matching names, and use
available model IDs, but it does not protect prompt contracts. Historical
quality evidence is split between heterogeneous manual delegation-log entries,
668 session files, and one local doc-writer evaluation, so model, prompt version,
runtime failure, and task-brief failure cannot be compared reliably. This plan
adds static contract tests and a read-only history summarizer without putting
paid or nondeterministic model calls in normal validation.

## Current state

- `scripts/validate.mjs:48-97` checks agent frontmatter name/description and
  catalog membership, not prompt-body contracts.
- `scripts/validate-agent-models.mjs:1-99` validates configured model IDs and
  should remain focused on model availability.
- `package.json:7-18` explicitly lists test files; new tests must be added to
  that command.
- Existing script tests use `bun:test` and temporary fixtures.
- No repository-owned agent prompt/eval fixtures exist.
- `/home/antisatori/.pi/agent/evals/subagents/doc-writer/runs/2026-06-21-canopy-examples-readme.md`
  is useful evidence but is outside the repository and is not a repeatable test.
- Session JSONL tool results contain agent name, model, exit code, stop reason,
  token usage, and task text, but task text may contain sensitive repository
  context and must not be copied into summaries.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Structural validation | `rtk npm run validate` | exit 0 |
| Model validation | `rtk npm run validate-agent-models` | exit 0 |
| Test suite | `rtk npm test` | all tests pass |
| Usage summary smoke | `rtk npm run agent-usage-report -- --help` | usage text, exit 0, no files written |
| Diff hygiene | `rtk git diff --check` | no output |

Run from `/home/antisatori/ghq/github.com/dowdiness/skills`.

## Scope

**In scope**:
- `scripts/agent-prompt-contracts.mjs` (new)
- `scripts/agent-prompt-contracts.test.mjs` (new)
- `scripts/agent-usage-report.mjs` (new)
- `scripts/agent-usage-report.test.mjs` (new)
- `scripts/fixtures/agent-sessions/` with synthetic, non-sensitive JSONL fixtures
- `package.json`
- `README.md` or `scripts/README.md` for concise usage documentation

**Out of scope**:
- Live/paid model invocation
- CI uploading session data
- Committing real session logs, delegation logs, prompts, or model responses
- Changing subagent runtime logging format
- Scoring semantic correctness automatically

## Steps

### Step 1: Define static prompt contracts

Create `scripts/agent-prompt-contracts.mjs` with a small explicit catalog keyed
by current agent name. Each contract may assert:

- required headings or exact phrases;
- forbidden model-name patterns in descriptions;
- required role-specific STOP/completion language;
- coordinator status/incomplete-review requirements;
- unchanged frontmatter requirements delegated to existing parsers.

Use `parseFrontmatter` from `scripts/frontmatter.mjs`. Keep assertions semantic
enough to survive harmless prose edits: prefer required concepts/headings over
full prompt snapshots.

Export pure functions that accept text or a directory so tests do not depend on
user-home files.

**Verify**:
`node scripts/agent-prompt-contracts.mjs`
→ checks the repository agents and exits 0 with a concise count.

### Step 2: Add deterministic prompt-contract tests

Create `scripts/agent-prompt-contracts.test.mjs` using `bun:test` and temporary
fixtures. Cover:

- all 16 current agents have a contract or are explicitly listed as intentionally
  minimal;
- operational agents expose the final Plan 001 evidence/STOP/completion concepts;
- specialist reviewer descriptions contain no provider/model branding;
- ensemble and parallel coordinators expose status/incomplete semantics;
- malformed frontmatter and missing headings produce actionable failures;
- contract checks never inspect provider credentials or invoke `pi`.

Append this test file to the existing explicit `npm test` command.

**Verify**:
`bun test scripts/agent-prompt-contracts.test.mjs`
→ all cases pass.

### Step 3: Build a privacy-preserving session usage summarizer

Create `scripts/agent-usage-report.mjs` as a read-only CLI. It accepts one or
more explicit JSONL paths/directories and reports only aggregates:

- agent name;
- invocation count;
- runtime success/failure/aborted count;
- recorded model IDs;
- turns, token totals, and duration when present;
- unknown/malformed record count.

Never emit task text, source excerpts, cwd, user messages, model responses,
secret values, or file names from reviewed repositories. Default to no path and
print help; do not silently scan `~/.pi`.

Support `--format table|json` and `--help`. JSON output needs a schema version.
Do not merge the manual delegation-log outcome labels into runtime success:
those represent human quality judgments and are not equivalent to process exit.

**Verify**:
`node scripts/agent-usage-report.mjs --help`
→ exits 0 and states the privacy exclusions.

### Step 4: Test the usage summarizer with synthetic JSONL

Add small synthetic fixtures under `scripts/fixtures/agent-sessions/` containing:

- successful single-agent result;
- failed result;
- parallel result with one missing leaf;
- malformed line;
- task text containing a fake credential marker to prove output redaction by
  omission.

Create `scripts/agent-usage-report.test.mjs` to assert aggregate counts and that
none of the sensitive fixture strings, tasks, cwd values, or response text
appear in table or JSON output.

Add the test file to `npm test`.

**Verify**:
`bun test scripts/agent-usage-report.test.mjs`
→ all cases pass and privacy assertions hold.

### Step 5: Add scripts and documentation

Add package scripts:

- `validate-agent-prompts`: run the static contract checker;
- `agent-usage-report`: run the read-only summarizer.

Call `validate-agent-prompts` from `scripts/validate.mjs` by importing its pure
checker or duplicating no logic. Do not call the usage reporter from validation.

Document in `scripts/README.md`:

- static contracts protect prompt shape, not model behavior;
- usage reporting is opt-in and aggregate-only;
- exact examples using an explicit session directory;
- real session data must never be committed;
- live model evaluations remain a future opt-in facility.

**Verify**:
`rtk npm run validate-agent-prompts` and
`rtk npm run agent-usage-report -- --help`
→ both exit 0.

### Step 6: Run the complete gate

Run all commands in “Commands you will need.” Confirm that no command calls a
model or writes outside temporary test directories.

## Test plan

Follow existing `bun:test` script-test style. Use only synthetic fixtures.
Required cases are listed in Steps 2 and 4. Tests must be deterministic offline
and must pass without provider credentials.

## Done criteria

- [ ] All current agents have explicit static prompt-contract coverage.
- [ ] Static checks clearly state that they are not behavioral model evaluation.
- [ ] Usage reports omit task/cwd/content data and separate runtime from human quality.
- [ ] No real local session/eval artifact is committed.
- [ ] Normal validation performs zero model calls.
- [ ] `rtk npm run validate`, `rtk npm run validate-agent-models`, and `rtk npm test` pass.
- [ ] `rtk git diff --check` passes.
- [ ] The row for Plan 003 in `plans/README.md` is updated.

## STOP conditions

- Plans 001/002 final headings are not yet stable.
- A proposed test requires paid/live model execution.
- Privacy-preserving aggregation cannot be implemented without exposing task,
  cwd, source, or response content.
- Existing session JSON shape differs from synthetic assumptions; add a bounded
  fixture from structure only, never copy real content.

## Maintenance notes

Treat prompt contracts like API contracts: add a focused assertion only for
behavior that history shows matters. Avoid snapshots of whole prompts. A future
live-eval system should be separately invoked, budgeted, provider-approved, and
store only redacted rubrics and normalized outcomes.
