# Plan 001: Make operational agent prompts evidence-bounded and verifiable

> **Executor instructions**: Follow this plan step by step. Preserve all current
> frontmatter model and fallback values byte-for-byte. Run every verification
> command before completion. If a STOP condition occurs, stop and report rather
> than improvising.
>
> **Drift check (run first)**:
> `git diff --stat 6336d7b..HEAD -- agents/{scout,moonbit-scout,planner,moonbit-planner,worker,mechanic,doc-writer}.md`
>
> The execution checkout must contain this plan and the current `model:` and
> `fallbackModels:` values committed alongside it. Snapshot those values before
> editing. Also run
> `git diff -- agents/{scout,moonbit-scout,planner,moonbit-planner,worker,mechanic,doc-writer}.md`
> and preserve every current `model:` and `fallbackModels:` line.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `6336d7b`, 2026-07-21; current frontmatter state inspected

## Why this matters

The operational agents are useful when their task brief is narrow, but the
usage record shows repeated scope mismatch, loose output, unverified API claims,
and completion claims that the parent had to correct. The strongest prompts
already constrain tools and output shape; this plan adds only the missing
role-specific controls rather than a large shared boilerplate block.

## Current state

- `agents/scout.md:10-51` asks for compressed handoff context but has no output
  ceiling and requests raw code excerpts without a sensitive-content rule.
- `agents/moonbit-scout.md:13-80` requires at least two API candidates when
  available, which can encourage weak candidates, and has no evidence status.
- `agents/planner.md:12-52` and `agents/moonbit-planner.md:13-91` tell a worker to
  execute the plan verbatim but do not distinguish source-verified facts from
  inherited or unverified context.
- `agents/worker.md:8-25` has no explicit scope, dirty-tree, validation, or STOP
  contract.
- `agents/mechanic.md:11-43` is appropriately narrow but does not say that its
  tool set cannot delete/move files or run validation commands.
- `agents/doc-writer.md:24-89` has strong source rules, but does not require a
  final reread/existence check or prohibit unsupported quantitative claims.
- Frontmatter is runtime configuration. Prompt-body hardening must not alter it.

Repository convention: concise, agent-facing instructions live in each
`agents/*.md`; deterministic checks belong under `scripts/`. Match the compact
checklist style in `agents/moonbit-reviewer.md:13-72`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Structural validation | `rtk npm run validate` | `RESULT: 42/42` or the updated total, exit 0 |
| Model validation | `rtk npm run validate-agent-models` | all configured model IDs validated, exit 0 |
| Test suite | `rtk npm test` | all tests pass |
| Diff hygiene | `rtk git diff --check` | no output, exit 0 |

Run commands from `/home/antisatori/ghq/github.com/dowdiness/skills`.

## Scope

**In scope**:
- `agents/scout.md`
- `agents/moonbit-scout.md`
- `agents/planner.md`
- `agents/moonbit-planner.md`
- `agents/worker.md`
- `agents/mechanic.md`
- `agents/doc-writer.md`

**Out of scope**:
- All frontmatter fields in the seven files
- Review agents and scheduler behavior
- Model/fallback ordering
- New generic prompt framework or copied boilerplate file

## Git workflow

- Work on the operator-selected branch; do not create, push, or publish a PR.
- Keep one logical commit for these prompt-body changes if the operator later
  requests a commit.
- Do not stage or overwrite unrelated dirty changes.

## Steps

### Step 1: Bound Scout output and evidence

In `agents/scout.md`:

- Replace the unconditional “actual code excerpts” expectation with minimal,
  task-relevant excerpts only.
- Add a default final-output target of at most 600 words; allow the caller to
  override it explicitly. For larger scopes, return the highest-value evidence
  and list deferred areas rather than silently truncating.
- Require each factual claim to cite a file and exact line range actually read.
- Mark deductions as `inferred` and unknowns as `unverified`; do not present
  them as facts.
- Prohibit reproducing suspected secrets, credentials, tokens, or PII. Cite the
  location and kind without quoting the value.
- Add STOP behavior for missing target/scope and tasks requiring edit/bash.

In `agents/moonbit-scout.md`, apply the same controls and additionally:

- Replace candidate-count pressure with “report only directly evidenced API
  candidates; zero is acceptable.”
- Label each API candidate `source-verified` or `needs moon ide confirmation`.
- Do not infer generated `.mbti` content from `.mbt` source.

**Verify**:
`rg -n "600 words|source-verified|needs moon ide|secret|STOP" agents/scout.md agents/moonbit-scout.md`
→ both files show their applicable controls.

### Step 2: Add provenance and preconditions to Planner output

In both planner prompts:

- Add `## Evidence and Assumptions` and `## Non-goals` to the output contract.
- Require reuse candidates to carry one status: `source-verified`,
  `inherited-unverified`, or `requires-tool-confirmation`.
- Change “worker will execute it verbatim” to a safer contract: the worker must
  first verify named files, symbols, package roots, and assumptions.
- Add a 30-step ceiling; larger work must be divided into dependency-ordered
  phases.
- STOP when the objective, target package/module, or required source context
  cannot be established rather than guessing paths or APIs.

For `moonbit-planner.md`, explicitly state that it cannot run `moon ide`,
`moon check`, or `moon test`; all such items are planned preflight commands,
not completed verification.

**Verify**:
`rg -n "Evidence and Assumptions|Non-goals|source-verified|requires-tool-confirmation|30" agents/planner.md agents/moonbit-planner.md`
→ both files contain the new contract.

### Step 3: Strengthen Worker execution and completion reporting

In `agents/worker.md`:

- Require reading the nearest `AGENTS.md`/`CLAUDE.md` and inspecting existing
  working-tree changes before editing.
- State that delegated scope and acceptance criteria are authoritative; do not
  broaden architecture or modify unrelated files.
- STOP and report when objective, files, invariants, or acceptance criteria are
  materially ambiguous.
- Require the lightest relevant validation unless the task explicitly forbids
  it; report exact commands, cwd, and pass/fail status.
- Add `## Validation` and `## Remaining Risks` to the final output.
- Never claim completion when required validation failed or was not run; use
  `INCOMPLETE` and state why.

**Verify**:
`rg -n "AGENTS.md|INCOMPLETE|## Validation|Remaining Risks|working-tree" agents/worker.md`
→ all required concepts are present.

### Step 4: Make Mechanic capability limits and coverage measurable

In `agents/mechanic.md`:

- Explicitly list unsupported operations: file deletion/move, shell commands,
  validation execution, architectural decisions, and inferred edits.
- Require requested/matched/applied/skipped counts for repeated changes.
- STOP when a requested operation requires an unsupported capability or the
  exact pattern is ambiguous.
- Keep the existing “validation not run” contract.

**Verify**:
`rg -n "delet|move|matched|applied|skipped|unsupported" agents/mechanic.md`
→ capability and coverage rules are present.

### Step 5: Make Doc-writer verify its own deliverables

In `agents/doc-writer.md`:

- After editing, reread every changed/created document and confirm that every
  requested target exists.
- Add a compact requested-target coverage list to the final response.
- Do not claim line-count, word-count, percentage reduction, test result, git
  history, or commit state unless directly supplied or deterministically
  verified with available tools.
- Use `INCOMPLETE` when a requested file was not created/updated or a required
  claim could not be verified.
- Keep existing source-first, docs-only, and validation-not-run rules.

**Verify**:
`rg -n "reread|coverage|INCOMPLETE|word-count|percentage" agents/doc-writer.md`
→ completion checks are explicit.

### Step 6: Run the complete verification gate

Run all commands in “Commands you will need.” Then inspect:

`rtk git diff -- agents/{scout,moonbit-scout,planner,moonbit-planner,worker,mechanic,doc-writer}.md`

Confirm only prompt bodies changed and all pre-existing frontmatter values remain
exactly as they were at task start.

## Test plan

This plan changes Markdown prompts only. Deterministic prompt-contract tests are
introduced by Plan 003; until then, use the exact `rg` checks in each step plus
repository validation. Exercise one manual dry-run brief per role only after the
prompt patch is reviewed; do not use live model calls as a merge gate here.

## Done criteria

- [ ] All seven prompt bodies include the specified role-specific guardrails.
- [ ] No `model:`, `fallbackModels:`, `name:`, `description:`, or `tools:` value changed.
- [ ] `rtk npm run validate` exits 0.
- [ ] `rtk npm run validate-agent-models` exits 0.
- [ ] `rtk npm test` exits 0.
- [ ] `rtk git diff --check` exits 0.
- [ ] No files outside the in-scope list were modified by this plan.
- [ ] The row for Plan 001 in `plans/README.md` is updated.

## STOP conditions

- The current frontmatter differs from the values present when execution starts.
- The execution checkout does not contain this plan or its committed frontmatter baseline.
- A requested prompt rule conflicts with the declared tools.
- Verification fails twice or requires an out-of-scope source change.

## Maintenance notes

Keep guardrails role-specific and short. If repeated wording grows across agents,
consider a future generator only after behavioral evaluations demonstrate that
prompt length is not harming smaller fallback models.
