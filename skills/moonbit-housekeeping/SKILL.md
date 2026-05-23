---
name: moonbit-housekeeping
description: >
  Repo maintenance for MoonBit projects. Five subcommands: default (full
  audit-and-fix pipeline), check (fast read-only health check), fix (full
  check + auto-fix only), triage (project direction + branch pruning),
  release (pre-release prep). Use at session start, before commits, weekly
  for direction, and before releases.
---

# MoonBit housekeeping

Five subcommands covering two concerns: **code health** (default, check, fix) and **project direction** (triage, release).

## Usage

- `moonbit-housekeeping` — full audit-and-fix: all phases, auto-fix safe items, ask before destructive actions
- `moonbit-housekeeping check` — fast read-only health check: git + lint + sync
- `moonbit-housekeeping fix` — full check + auto-fix only, no destructive prompts
- `moonbit-housekeeping triage` — project direction: backlog + branch pruning + recommendations
- `moonbit-housekeeping release` — pre-release prep: changelog + api-review + doc-drift. Does **not** re-check git / lint / build / test; run `moonbit-housekeeping` first if those have not been verified.
- `moonbit-housekeeping help` — display TUTORIAL.md

## When to use

- **Start of session** -> `moonbit-housekeeping` (most common)
- **Read-only glance** -> `moonbit-housekeeping check`
- **End of long session** -> `moonbit-housekeeping fix`
- **Weekly / re-orienting** -> `moonbit-housekeeping triage`
- **Before release or major PR** -> `moonbit-housekeeping release`

## Execution

### Step 1: Preflight (coordinator)

```bash
which moon
```

If `moon` is not on PATH, report the error and stop.

### Step 2: Determine subcommand

| Input | Mode | Worker profile | Categories |
|-------|------|----------------|------------|
| (none) | audit | mechanical worker | git, lint, sync, build, test |
| `check` | report | mechanical worker | git, lint, sync |
| `fix` | fix | mechanical worker | git, lint, sync, build, test |
| `triage` | report+prune | review worker | triage |
| `release` | report | review workers | changelog, api-review, doc-drift |
| `help` / `tutorial` | none | none | display TUTORIAL.md |

### Step 2b: Handle help/tutorial

Read `TUTORIAL.md` from the same directory as this skill file and display its contents. Do not run any workers. Stop here.

### Step 3: Run workers

If the host agent supports delegated workers or parallel agent tasks, run the worker templates separately. If it does not, execute the same template workflow in the current agent and keep the same JSON output contract.

**Default (audit):** Run one mechanical worker using the Mechanical Worker Prompt Template with MODE=audit and CATEGORIES=git,lint,sync,build,test. After receiving output:
1. Auto-fix safe items (same as fix mode whitelist: moon fmt, moon info, moon test --update).
2. Detect destructive action candidates from git phase: stale branches (merged into main), orphan worktrees, branches with no activity >30 days and no open PR.
3. If destructive candidates found: display them with last-commit dates and ask "Clean up these branches/worktrees? [y/N]". If confirmed, run a mechanical prune worker using the triage prune template.
4. Render the unified report.

**Check:** Run one mechanical worker using the Mechanical Worker Prompt Template with MODE=report and CATEGORIES=git,lint,sync.

**Fix:** Run one mechanical worker using the Mechanical Worker Prompt Template with MODE=fix and CATEGORIES=git,lint,sync,build,test.

**Triage:** Run one review worker using the Triage Worker Prompt Template. After receiving output:
1. Write `docs/decisions-needed.md` using the Decisions-Needed format below — add new `needs-human-review` items, preserve existing human notes, remove items now classified as "done".
2. If `prune_candidates` is non-empty: display the list with last-commit dates and ask "Prune these? [y/N]". If confirmed, run a mechanical prune worker to execute the pruning.

**Release:** Run three review workers, in parallel when supported: changelog, api-review, doc-drift. Each uses its respective prompt template.

### Step 4: Render report (coordinator)

**Parse hygiene.** Worker prompts demand JSON-only output, but adherence is imperfect — preamble ("Now I have...", "The .mbti files are already in sync..."), code-fence wrappers (```json), and trailing commentary leak occasionally. Before parsing, apply lenient extraction:

1. **Strict pass first.** Try `JSON.parse` on the raw output. If it succeeds, proceed.
2. **Lenient fallback.** If strict fails, attempt one of these in order:
   - **Preferred — `parse-worker-output.py` (BAML schema-aligned parser).** For release workers (changelog, api-review, doc-drift), pipe the raw output through:
     ```
     ./parse-worker-output.py --root Changelog        # or ApiReview / DocDrift
     ```
     The script lives next to this SKILL.md, uses uv-managed Python 3.13 + `baml-lib`, and handles preamble, code-fence wrapping, and trailing commentary structurally (not by regex). Auto-installs deps on first run.
     Regression tests: see `tests/run-tests.nu` (27 fixtures covering happy path, real-world prose leaks, edge cases, CLI surface, stress, concurrency, and Codex review findings).
   - **Inline regex fallback** (if the script is unavailable): locate the first `{`, locate the matching closing `}` (balanced-brace count), discard everything outside. Strip ```json / ``` fences if present at the boundaries.
3. **Re-request on hard failure.** If both fail, ask the worker to re-output JSON-only — do not silently accept the prose-wrapped output.

Render the unified report (format below). If fixable items exist in report mode, suggest `moonbit-housekeeping fix`.

---

## Mechanical worker prompt template

~~~
You are a housekeeping agent for a MoonBit project. Run mechanical repo checks and output structured JSON.

MODE: {MODE}  (report = read-only, fix = apply safe changes, audit = apply safe changes + report destructive candidates)
CATEGORIES: {CATEGORIES}  (git, lint, sync, build, test)
WORKING DIRECTORY: {CWD}

RULES:
- MINIMIZE tool calls. Batch multiple commands into single Bash calls using && or ;
- Maximum 18 tool calls. If approaching the limit, report what you have and stop.
- OUTPUT FORMAT: respond with the JSON object matching the schema below only. Zero preamble ("Now I have...", "Let me analyze..."), zero trailing commentary. Code-fence wrapper is fine; raw prose is not.
- Discover submodules dynamically: parse .gitmodules for paths.
- Discover test targets dynamically: check for moon.mod.json in each submodule directory.
- Skip categories not in {CATEGORIES}.

---

PHASE 1 — git snapshot (categories: git, sync)

Run ALL of these in ONE Bash call:
  echo "=== STATUS ===" ; git status --short ;
  echo "=== AHEAD ===" ; git log --oneline origin/main..HEAD ;
  echo "=== BEHIND ===" ; git log --oneline HEAD..origin/main ;
  echo "=== MERGED ===" ; git branch --merged main | grep -v main ;
  echo "=== WORKTREES ===" ; git worktree list ;
  echo "=== PRS ===" ; gh pr list --state open --json number,title,headRefName,statusCheckRollup 2>/dev/null || echo "gh not available" ;
  echo "=== SUBMODULES ===" ; git submodule status ;
  echo "=== UNTRACKED ===" ; git ls-files --others --exclude-standard ;
  echo "=== BRANCH_DATES ===" ; git for-each-ref --sort=committerdate refs/heads/ --format='%(refname:short) %(committerdate:short) %(subject)' ;
  echo "=== VERSION_TAG_DRIFT ===" ; VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' moon.mod.json 2>/dev/null | head -1) ; if [ -n "$VER" ]; then TAG_SHA=$(git rev-parse "v$VER^{commit}" 2>/dev/null || git rev-parse "$VER^{commit}" 2>/dev/null) ; HEAD_SHA=$(git rev-parse HEAD) ; if [ -z "$TAG_SHA" ]; then echo "version=$VER tag=absent" ; elif [ "$TAG_SHA" = "$HEAD_SHA" ]; then echo "version=$VER tag=aligned" ; else echo "version=$VER tag_commit=${TAG_SHA:0:7} head_commit=${HEAD_SHA:0:7} drift=$(git rev-list --count $TAG_SHA..HEAD)_ahead" ; fi ; fi

For submodules, note if any are dirty (+prefix) or on detached HEAD.
For VERSION_TAG_DRIFT: if the output shows `drift=N_ahead`, emit a severity-warning
item in the git phase: "version {VER} tag is at {tag_commit}, HEAD is at {head_commit}
({N} commits ahead) — do not publish at this version until the tag is moved to HEAD
or a new version is cut". The `tag=aligned` and `tag=absent` cases produce no item.
This check catches the "published tag points to a different commit than the tree
being published" class of release mistake.

---

PHASE 2 — moon tools (categories: lint, sync)

Run ALL in ONE Bash call:
  moon update && moon fmt ; moon check 2>&1 ; moon info

If any command fails, the remaining commands still run due to ; separators.

---

PHASE 3 — git diff (runs if phase 2 ran)

Run in ONE Bash call:
  echo "=== STAT ===" ; git diff --stat ; echo "=== MBTI ===" ; git diff -- '*.mbti'

If MODE is "report": run `git checkout -- .` to revert all changes.
If MODE is "fix" or "audit": keep the changes. Report them as fixed items.

---

PHASE 4 — build + test (categories: build, test)

For build — run in ONE Bash call:
  echo "=== JS BUILD ===" ; moon build --target js 2>&1 ; echo "=== WEB BUILD ===" ; if [ -d examples/web/node_modules ]; then cd examples/web && npm run build 2>&1; else echo "skipped: node_modules not installed"; fi

For test — run in ONE Bash call:
  echo "=== MAIN ===" ; moon test 2>&1 ; for dir in $(grep 'path = ' .gitmodules | sed 's/.*= //'); do if [ -f "$dir/moon.mod.json" ]; then echo "=== $dir ===" ; (cd "$dir" && moon test 2>&1) ; fi ; done

---

OUTPUT SCHEMA:

{
  "phases": {
    "git": {
      "status": "pass|warn|fail",
      "items": [
        {"severity": "error|warning|info", "file": null, "message": "description", "fixable": false}
      ]
    },
    "lint": {"status": "pass|warn|fail", "items": [...]},
    "sync": {"status": "pass|warn|fail", "items": [...]},
    "build": {"status": "pass|warn|fail", "items": [...]},
    "test": {"status": "pass|warn|fail", "items": [...]}
  },
  "destructive_candidates": [],
  "truncated": false,
  "tool_calls_used": 15
}

Only include categories that were requested. Omit skipped categories from the JSON.

DESTRUCTIVE CANDIDATES (audit mode only):
If MODE is "audit", populate "destructive_candidates" by analyzing git phase output:
- Branches merged into main → candidate
- Branches with last commit >30 days ago and no open PR → candidate
- Worktrees referencing deleted or fully-merged branches → candidate
Format each as: {"type": "branch|worktree", "name": "...", "path": "... (worktree only)", "reason": "merged into main|stale (last commit YYYY-MM-DD, no open PR)|orphan worktree", "last_commit_date": "YYYY-MM-DD"}
If MODE is not "audit", set "destructive_candidates" to [].

STATUS RULES:
- "pass" = no issues found
- "warn" = non-blocking issues (dirty submodule, formatting needed, stale branch, commits ahead/behind)
- "fail" = blocking issues (test failure, build error, moon check error)

SEVERITY RULES:
- "error" = must fix (test failure, build error, lint error)
- "warning" = should fix (dirty submodule, formatting drift, stale branch, detached HEAD)
- "info" = informational (commits ahead/behind, open PRs, untracked files, skipped checks)

FIXABLE RULES:
- Set "fixable": true ONLY for: formatting changes (moon fmt), interface regeneration (moon info), snapshot updates (moon test --update)
- Everything else is "fixable": false

REMEMBER: Response = JSON object only. No preamble, no trailing commentary.
~~~

---

## Triage worker prompt template

~~~
You are a triage agent for a MoonBit project. Assess backlog freshness, identify stale branches, and produce project direction output as structured JSON.

WORKING DIRECTORY: {CWD}

RULES:
- Maximum 30 tool calls. Batch aggressively.
- OUTPUT FORMAT: respond with the JSON object only. Zero preamble ("Now I have...", "Let me analyze..."), zero trailing commentary. Code-fence wrapper is fine; raw prose is not.
- Separate observations from judgment.
- If uncertain, classify as "needs-human-review", not "done".
- Step 8 (synthesis) is lowest priority — skip it if tool_calls_used >= 25 and set recommendations to [].

WORKFLOW:

1. Read docs/TODO.md in one call.

2. Fetch GitHub issues and branch state in ONE Bash call:
   gh issue list --state open --json number,title,labels,body --limit 50 2>/dev/null || echo "gh not available" ;
   gh issue list --state closed --json number,title,labels --limit 20 2>/dev/null || echo "gh not available" ;
   echo "=== BRANCHES ===" ; git branch -vv ;
   echo "=== WORKTREES ===" ; git worktree list ;
   echo "=== MERGED ===" ; git branch --merged main | grep -v main ;
   echo "=== BRANCH_DATES ===" ; git for-each-ref --sort=committerdate refs/heads/ --format='%(refname:short) %(committerdate:short) %(subject)'

3. Parse `docs/plans/*.md` references from the TODO.md content read in step 1 — call this set TODO_PLAN_REFS. If TODO.md is missing or TODO_PLAN_REFS is empty, skip the existence check and proceed to step 4. Otherwise, in ONE Bash call (substitute TODO_PLAN_REFS with the parsed paths, space-separated):
   echo "=== PLANS ===" ; ls docs/plans/*.md 2>/dev/null ;
   for f in TODO_PLAN_REFS; do echo "=== $f ===" ; test -f "$f" && echo "EXISTS" || echo "MISSING" ; done

4. Check for completion evidence. For each TODO item, identify 1–3 key symbols it names (function names, type names, or file paths). Use `moon ide find-references <symbol>` if moon ide is available; otherwise fall back to `grep -rn <symbol> src/ examples/ 2>/dev/null`. A TODO item that references a symbol now implemented with a non-trivial body is likely "done".

5. Cross-reference TODO items with GitHub issues:
   - TODO items matching closed issues → likely "done"
   - Open issues not in TODO.md → report as "untracked_issues"

6. Classify each TODO item.

7. Identify stale branch/worktree candidates:
   - Branches merged into main → prune candidates
   - Branches with last commit > 30 days ago and no open PR → prune candidates
   - Worktrees referencing non-existent branches → prune candidates

8. Synthesize top 3 recommended next actions from all evidence (most impactful, unblocked active items).

OUTPUT SCHEMA:
{
  "category": "triage",
  "status": "pass|warn|fail",
  "findings": [
    {
      "id": "todo-1",
      "subject": "TODO item text (truncated)",
      "classification": "done|active|blocked|stale|needs-human-review",
      "confidence": "high|medium|low",
      "severity": "info|warning|error",
      "evidence": ["plan file exists: docs/plans/...", "matches closed issue #12"],
      "recommendation": "archive|keep|investigate"
    }
  ],
  "orphaned_plans": ["docs/plans/file-not-in-todo.md"],
  "untracked_issues": [
    {
      "number": 5,
      "title": "Issue title not tracked in TODO.md",
      "labels": ["enhancement"],
      "recommendation": "add-to-todo|ignore"
    }
  ],
  "prune_candidates": [
    {
      "type": "branch",
      "name": "feature/old-thing",
      "reason": "merged into main|last commit 45 days ago, no open PR",
      "last_commit_date": "2026-02-10",
      "last_commit_message": "fix: something"
    },
    {
      "type": "worktree",
      "name": "old-feature",
      "path": "/home/user/project-old-feature",
      "reason": "orphan worktree — branch no longer exists",
      "last_commit_date": "2026-02-10",
      "last_commit_message": "wip: something"
    }
  ],
  "recommendations": [
    "Work on X — active plan, no blockers, highest impact based on TODO priority",
    "Archive Y — triage classified as done with high confidence",
    "Create a plan for Z — active item with no plan file"
  ],
  "truncated": false,
  "tool_calls_used": 12
}

CLASSIFICATION RULES:
- "done": evidence that the work is implemented AND plan status says complete (confidence: high)
- "active": plan exists, no completion evidence, not marked blocked (confidence: high)
- "blocked": plan explicitly says blocked or waiting on dependency (confidence: high)
- "stale": no plan file, no recent git activity, no code evidence (confidence: medium)
- "needs-human-review": mixed signals or insufficient evidence (confidence: low)

REMEMBER: Response = JSON object only. No preamble, no trailing commentary.
~~~

### Triage Prune Worker Prompt Template

Only run after the coordinator asks "Prune these? [y/N]" and the user confirms.

~~~
You are a cleanup agent. Execute branch and worktree pruning commands exactly as specified. Report what you did.

WORKING DIRECTORY: {CWD}
PRUNE_LIST: {PRUNE_LIST_JSON}

For each item in PRUNE_LIST:
- type "branch": run `git branch -d {name}` (safe delete — fails if unmerged)
- type "worktree": run `git worktree remove {path}` (use the path field, not name)

Run all commands. Report success or failure for each. If a branch delete fails (unmerged), report it as skipped — do NOT force-delete.

Output a plain text summary: what was pruned, what was skipped and why.
~~~

---

## Release worker prompt templates

Three review workers run in parallel when supported. Each outputs structured JSON.

### Changelog Prompt

~~~
You are a changelog agent for a MoonBit project. Draft a changelog from git history and output structured JSON.

WORKING DIRECTORY: {CWD}

RULES:
- Maximum 25 tool calls. Batch aggressively.
- OUTPUT FORMAT: respond with the JSON object only. Zero preamble ("Now I have...", "Let me analyze..."), zero trailing commentary. Code-fence wrapper is fine; raw prose is not.

WORKFLOW:
1. Find the base reference in ONE call:
   echo "=== LATEST TAG ===" ; git describe --tags --abbrev=0 2>/dev/null || echo "NO_TAGS" ; echo "=== COMMIT COUNT ===" ; git rev-list --count HEAD
2. Get commits since base in ONE call:
   If tag exists: git log <tag>..HEAD --oneline --no-merges
   If no tag: git log -50 --oneline --no-merges
3. Group commits by conventional commit type (feat, fix, chore, docs, perf, refactor, test).
   For commits without conventional prefix, infer from message content.
4. Draft user-facing changelog entries. Drop chore/internal commits unless they affect users.
5. Suggest semantic version bump: feat → minor, fix → patch, BREAKING → major, only chore/docs → none.

OUTPUT SCHEMA:
{
  "category": "changelog",
  "status": "pass",
  "base": {"type": "tag|commit_count", "value": "v0.1.0 or 50"},
  "total_commits": 23,
  "suggested_bump": "major|minor|patch|none",
  "bump_confidence": "high|medium|low",
  "sections": [
    {
      "type": "added|changed|fixed|removed|deprecated|performance",
      "entries": [
        {"description": "User-facing description", "commits": ["abc1234"], "breaking": false}
      ]
    }
  ],
  "skipped_commits": ["def5678 chore: update submodules"],
  "truncated": false,
  "tool_calls_used": 5
}

REMEMBER: Response = JSON object only. No preamble, no trailing commentary.
~~~

### API Review Prompt

~~~
You are an API review agent for a MoonBit project. Classify .mbti interface changes by risk and intent.

WORKING DIRECTORY: {CWD}

RULES:
- Maximum 25 tool calls. Batch aggressively.
- OUTPUT FORMAT: respond with the JSON object only. Zero preamble ("Now I have...", "Let me analyze..."), zero trailing commentary. Code-fence wrapper is fine; raw prose is not.
- Separate observations (what changed) from judgment (is it intentional).

WORKFLOW:
1. Run `moon info` then `git diff -- '*.mbti'` in ONE call.
2. Parse the diff to identify which packages changed. For each changed package:
   moon ide analyze <package_dir>/
   Symbols with "usage: 0" are potential dead code.
3. Cross-reference analyze output with the diff:
   - Added symbols: new in diff + present in analyze output
   - Removed symbols: gone from diff + absent from analyze output
   - Usage counts reveal impact: removing a symbol with "usage: 15" is high-risk
4. Check recent git log per file to understand intent.
5. Run `git checkout -- '*.mbti'` after analysis to revert moon info changes.

OUTPUT SCHEMA:
{
  "category": "api-review",
  "status": "pass|warn|fail",
  "findings": [
    {
      "file": "editor/pkg.generated.mbti",
      "change_type": "added|removed|modified",
      "symbol": "pub fn SyncEditor::new_method(self) -> Unit",
      "classification": "intentional|accidental|needs-review",
      "confidence": "high|medium|low",
      "severity": "info|warning|error",
      "evidence": ["recent commit abc1234 added this method"],
      "breaking": false
    }
  ],
  "summary": {"added": 3, "removed": 0, "modified": 1, "breaking_changes": 0},
  "truncated": false,
  "tool_calls_used": 10
}

CLASSIFICATION RULES:
- "intentional": change matches recent work, source file has corresponding implementation
- "accidental": no corresponding source change, likely drift from moon info regeneration
- "needs-review": unclear intent, mixed signals
- Removed public symbols are always severity "warning" or "error"

REMEMBER: Response = JSON object only. No preamble, no trailing commentary.
~~~

### Doc Drift Prompt

~~~
You are a doc-drift agent for a MoonBit project. Check development docs for stale references.

WORKING DIRECTORY: {CWD}

RULES:
- Maximum 25 tool calls. Batch aggressively.
- OUTPUT FORMAT: respond with the JSON object only. Zero preamble ("Now I have...", "Let me analyze..."), zero trailing commentary. Code-fence wrapper is fine; raw prose is not.
- ONLY check development docs, READMEs, and plan references.
- Do NOT check docs/architecture/ — those describe principles, not symbols.
- Do NOT check submodule docs — different ownership.

SCOPE:
- docs/development/*.md
- docs/decisions/*.md
- docs/TODO.md (file/path references only)
- README.md, AGENTS.md
- docs/plans/*.md (active plans only, not archived)

WORKFLOW:
1. List all in-scope doc files in ONE Bash call:
   echo "=== DEV ===" ; ls docs/development/*.md 2>/dev/null ;
   echo "=== DECISIONS ===" ; ls docs/decisions/*.md 2>/dev/null ;
   echo "=== PLANS ===" ; ls docs/plans/*.md 2>/dev/null ;
   echo "=== ROOT ===" ; ls README.md AGENTS.md 2>/dev/null
2. Read each doc file (batch where possible).
3. Extract concrete references: file paths, package names, function names, command examples.
   Ignore principle-level statements ("the framework uses X pattern").
4. Verify file references exist in ONE batched Bash call.
5. For function/type references, use moon ide find-references or grep fallback.
6. Report drift.

OUTPUT SCHEMA:
{
  "category": "doc-drift",
  "status": "pass|warn|fail",
  "findings": [
    {
      "doc_file": "docs/development/workflow.md",
      "reference": "framework/core/types.mbt",
      "reference_type": "file_path|symbol|command|package",
      "classification": "valid|stale|renamed|removed",
      "confidence": "high|medium|low",
      "severity": "info|warning|error",
      "evidence": ["file does not exist", "similar file at framework/core/node.mbt"],
      "recommendation": "update reference|remove reference|investigate"
    }
  ],
  "docs_checked": 12,
  "references_checked": 45,
  "truncated": false,
  "tool_calls_used": 15
}

REMEMBER: Response = JSON object only. No preamble, no trailing commentary.
~~~

---

## Report Format (coordinator renders this from JSON)

### Default (audit) / Fix report

```
## Housekeeping Report

git:   {STATUS}  ({one-line summary})
lint:  {STATUS}  ({one-line summary})
sync:  {STATUS}  ({one-line summary})
build: {STATUS}  ({one-line summary})
test:  {STATUS}  ({one-line summary})
```

If audit mode and `destructive_candidates` is non-empty, append:

```
### Cleanup candidates

| Type | Name | Reason | Last commit |
|------|------|--------|-------------|
| branch | feature/old | merged into main | 2026-03-01 |
| worktree | /path/to/wt | orphan worktree | 2026-02-15 |

Clean up these branches/worktrees? [y/N]
```

If confirmed, run a mechanical prune worker using the triage prune template.

### Check report

```
## Housekeeping Report (check)

git:   {STATUS}  ({one-line summary})
lint:  {STATUS}  ({one-line summary})
sync:  {STATUS}  ({one-line summary})
```

### Triage report

```
## Triage Report

backlog:  {STATUS}  ({N} done, {N} active, {N} blocked, {N} stale, {N} needs-review)
plans:    {STATUS}  ({N} orphaned)
issues:   {STATUS}  ({N} untracked)
branches: {STATUS}  ({N} prune candidates)
decisions-needed: updated  ({N} added, {N} resolved)

### Recommendations
1. {recommendation 1}
2. {recommendation 2}
3. {recommendation 3}
```

If prune_candidates is non-empty, show the list and ask whether to prune those branches/worktrees.

### Decisions-needed format (coordinator writes this after triage)

Read `docs/decisions-needed.md` if it exists. Then:
- **Add** items with `classification: needs-human-review` not already present
- **Remove** items now classified as `done` (high confidence)
- **Preserve** any human-added notes on existing items unchanged

Format for new items:

```markdown
### <short title>
**Source:** <TODO item or plan file>
**Context:** <what the decision is about, 2-3 sentences>
**Blocks:** <what this blocks, or "Nothing directly">
**Evidence:** <evidence from triage>
**Added:** <today's date>
```

### Release report

```
## Release Report

changelog:  {STATUS}  ({N} commits → suggested bump: {minor/patch/none})
api-review: {STATUS}  ({N} changes: {N} intentional, {N} needs review, {N} breaking)
doc-drift:  {STATUS}  ({N} docs checked, {N} stale references)

### Publishing sequence (when ready)

This skill produces release *artifacts*. It does NOT tag, release, or publish —
those are irreversible and stay under user control. The order that avoids
drift between tag, GitHub release, and mooncakes:

1. Review the changelog draft. Amend claims like "all X" / "full Y" / "complete
   support for Z" that the in-house api-review agent cannot verify against
   external facts (it reasons from diffs, not from spec knowledge).
2. Run external independent review (e.g. Codex or similar) on the changelog.
   The in-house api-review catches mechanical/structural issues; external
   review catches substantive claims. Amend per findings.
3. ONLY THEN, as one atomic sequence:
     - `git tag -a vX.Y.Z -m "..."`
     - `git push origin vX.Y.Z`
     - `gh release create vX.Y.Z --notes-file CHANGELOG.md`
     - `moon publish --dry-run`  (inspect bundle contents)
     - `moon publish`            (irreversible on mooncakes)

Do not tag before step 2. Mooncakes publishes are permanently immutable; a
tag pointing at a different commit than the published bundle cannot be
fixed retroactively without either force-moving the tag (only safe if
zero consumers have cached it) or cutting a new version for a docs fix.

Dry-run note: `moon publish --dry-run` can exit 255 on success — trust the
`Server status: 2xx` line, not the shell exit code.
```

### Details section (any report with warnings/errors)

```
### Details

**lint (WARN)**
- warning: `editor/foo.mbt` needs formatting (fixable)

**triage (WARN)**
- warning: TODO item "add X feature" appears done (high confidence) — recommend archive
- info: 3 orphaned plans in docs/plans/ not referenced in TODO.md
```

If MODE was "fix", list what was auto-fixed.
If MODE was "report" and fixable items exist:
> Run `moonbit-housekeeping fix` to auto-fix {N} items.

---

## Fix mode whitelist

ONLY these operations are allowed in fix mode:
- `moon fmt` — reformat .mbt files (deterministic, reversible)
- `moon info` — regenerate .mbti interface files (deterministic)
- `moon test --update` — update test snapshots (reviewable via git diff)

Never `git pull`, `git push`, `git stash`, checkout branches, modify source logic, delete files, or commit.

Branch/worktree pruning is handled by the triage prune worker after explicit user confirmation — never in fix mode.

## Guardrails

- Default mode is **read-only**. Phase 2 changes are reverted after phase 3 in report mode.
- Tool-call limits in worker templates prevent runaway execution.
- Dynamic discovery (`.gitmodules`, `moon.mod.json`) prevents hardcoded staleness.
- Classify build failures in `examples/web/` due to missing `node_modules` as skipped.
- If `gh` CLI is not available, PR and issue checks are skipped gracefully.
- Branch pruning uses `git branch -d` (safe delete) — never `git branch -D` (force).
