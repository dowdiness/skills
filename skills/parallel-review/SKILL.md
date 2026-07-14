---
name: parallel-review
description: Use when reviewing a MoonBit/Canopy change or pull request before merge and multiple independent review perspectives are useful
---

# Parallel Pre-Merge Code Review

This skill is supported for MoonBit/Canopy changes and pull requests. It is
not a generic repository review workflow: every reviewer is specialized for
MoonBit, Canopy package boundaries, or the Canopy validation toolchain.

The review sends the parent-supplied target context, including the complete
diff or relevant hunks, to the coordinator and all four reviewers. Use it only
with repositories and model providers approved for that source code. The skill
does not redact secrets or proprietary content.


Dispatch one `parallel-reviewer` coordinator before merging a MoonBit/Canopy
change. The coordinator runs four specialized, read-only reviewers in parallel
and consolidates their reports.

## Usage

`/parallel-review` — dispatch `parallel-reviewer` once for a PR or the current
change. Use the packaged user/global agent with the default user scope. If the
project has a deliberate `.pi/agents/parallel-reviewer.md` override, use
`agentScope: "both"` so the nearest project definition takes precedence.

For Canopy's scheduler extension, use
`/scheduler parallel-review <request>`. The scheduler writes the complete
tracked diff and untracked file contents to a concrete context file before
launching the coordinator, and loads the `subagent` extension for it.

The parent session supplies one self-contained context:

- target: PR URL/number or current branch
- objective: what the change is intended to accomplish
- changed files: complete path list
- diff: actual diff or relevant hunks; write large diffs to a concrete file
- package roots and applicable validation commands
- known risks and validation already performed by the parent

Passing only file paths is insufficient. Do not dispatch the coordinator until
the objective and diff or relevant hunks are present.

## Runtime dependency

The coordinator and four reviewer definitions are distributed in the
repository's `agents/` directory. Use `npm run install-pi-package` or
`npm run install-local` from the repository checkout to install them into
`~/.pi/agent/agents/` together with the skill and extension resources.

Installing only this directory with an Agent Skills client does not install the
agent definitions. In that case, install the package with the repository helper
or copy the five `agents/*.md` files into the user agent directory before use.
If any required agent is unavailable, stop and report an incomplete review
rather than silently substituting a different role.

## Workflow

1. Gather the complete review context in the parent session.
2. Dispatch `parallel-reviewer` exactly once with that context.
3. The coordinator reads only the target files, supplied diff paths, and related
   paths named by the parent. It must not discover additional scope or infer the
   objective.
4. The coordinator validates the objective and diff/hunks before dispatch.
5. The coordinator spawns all four reviewers simultaneously with the same
   context.
6. The coordinator waits for all results and does not manually retry failures.
7. It classifies each result as `usable report received` or
   `failed-or-missing`, deduplicates findings, resolves contradictions, ranks
   severity, and returns one concise report.

The coordinator and reviewers are strictly read-only. Reviewers do not run
tests, formatters, builds, or shell commands; validation commands are
recommendations for the parent session only.

If the context is incomplete or any reviewer is failed-or-missing, the result
is incomplete and must not be described as clean, complete, or merge-ready.

## Reviewer roles

| Agent | Focus |
|---|---|
| `moonbit-reviewer` | MoonBit correctness, package boundaries, public API, `.mbti` drift, and Canopy validation risks |
| `reviewer-flash` | Crashes, edge cases, stale references, invariant violations, and semantic regressions |
| `reviewer-mimo` | Readability, naming, unnecessary mutation, manual loops/indexing, and MoonBit idioms |
| `reviewer-qwen` | Exported surface, re-exports, constructors/fields, trait bounds, and package ownership |

## Output contract

```markdown
## Reviewer Status
- `moonbit-reviewer`: usable report received | failed-or-missing
- `reviewer-flash`: usable report received | failed-or-missing
- `reviewer-mimo`: usable report received | failed-or-missing
- `reviewer-qwen`: usable report received | failed-or-missing

## Files Reviewed
- `path/to/file.mbt` (lines X-Y)

## Critical (must fix)
- `file.mbt:42` - Issue description

## Warnings (should fix)
- `file.mbt:100` - Issue description

## Suggestions (consider)
- `file.mbt:150` - Improvement idea

## Summary
Overall assessment in 2-3 sentences.
```

Every reviewer must have a status entry. If one is `failed-or-missing`, start
`Summary` with `INCOMPLETE REVIEW`, name every missing reviewer, and do not
claim a clean, complete, or merge-ready result. Preserve runtime fallback notes
only when the runtime returns them; never infer a rate limit, model, or attempt
count.
