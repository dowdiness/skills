---
name: git-worktree-submodule-hygiene
description: >
  Use when creating, removing, or working across git worktrees or
  submodules — before force-pushing, before deleting a worktree, after
  `git worktree add`, when merging or deleting branches with `gh pr
  merge`/`gh pr close`, when bumping a submodule pointer, when merging a
  stack of dependent PRs, or when another agent/process may be operating
  on the same checkout concurrently.
---

# Git worktree and submodule hygiene

## Overview

Worktrees and submodules multiply the ways "the branch I think I'm on" and
"the state I think is there" can diverge from reality. This is a catalog of
the concrete failure modes and their fixes, not a general git tutorial.

## 1. Verify before you write

- Before editing or committing: check `git branch --show-current` and `git
  worktree list`. If the current checkout is for unrelated work, create a
  dedicated branch/worktree instead of modifying someone else's checkout.
- Before any push, especially `--force`/`--force-with-lease`: print `pwd &&
  git remote -v` in the **same** shell call as the push. A prior `cd` into a
  submodule may not have reset by the time the next command runs.
- Prefer `git -C <path> <cmd>` over `cd <path> && <cmd>` wherever possible —
  it never leaves cwd assumptions to go stale between calls.
- Never push directly to a shared/default branch (submodule or otherwise)
  without asking first, no matter how small the change looks.

## 2. Worktree lifecycle

- **`git worktree add` does not populate submodules.** The submodule
  directories are completely empty — not even a `.git` gitdir pointer,
  verified with a local worktree+submodule repro — until you run `git
  submodule update --init --recursive`. Verify with `ls <submodule>/`
  showing real files, not just `.git`, before running any build/test
  tooling in the new worktree.
- **Never remove a worktree without asking.** A branch showing as "merged"
  does not mean the worktree has no other uncommitted work sitting in it —
  treat worktrees like open editor tabs.
- **Worktrees holding submodules resist `git worktree remove`** —
  `fatal: working trees containing submodules cannot be moved or removed`
  (verified verbatim, git 2.x). After confirming the worktree is clean
  (`git -C <worktree> status --short --branch`) and the branch's changes
  are captured on the target branch (`git cherry -v origin/main <branch>`
  shows only `-` entries, or a path-scoped diff against the target is
  empty), deinit its submodules first (`git -C <worktree> submodule
  deinit -f --all`), then `git worktree remove --force <worktree>` — this
  exact two-step sequence was reproduced end-to-end locally and succeeds.
- **Self-removing your own worktree:** if the session's working directory
  IS the worktree being deleted, do the entire sequence (cd to the main
  repo root, worktree remove with the submodule-deinit fallback, branch
  delete) as **one self-contained shell command**. Tooling resets cwd to
  the project's main working directory between calls, not to whatever path
  you last `cd`'d into — a multi-call removal can strand a later call on a
  path that no longer exists.

## 3. Submodule pointer hygiene

- **Use the full 40-character SHA**, not a short prefix, when checking out
  a submodule commit. A short prefix can resolve to an unrelated local
  object that happens to share the prefix. Fetch first, then check out the
  full SHA, or verify with `git -C <submodule> cat-file -t <sha>` before
  trusting a short form from a PR description or log.
- **Pin experiment-only submodule commits with a tag.** If a parent PR
  points a submodule gitlink at a commit on a review/experiment branch
  (not that submodule's default branch), push the commit and add a separate
  tag on the submodule remote that peels to the exact commit, and document
  both branch and tag. A gitlink is a bare SHA — it's reachable only while
  that SHA stays reachable on the remote, and a branch under review can be
  rebased or force-pushed out from under it. If the branch changes, update
  gitlink, tag, and docs together.
- **A submodule module rename does not propagate to the parent's
  path-deps.** After bumping a pointer whose submodule renamed its own
  module name, grep the parent repo's active code (skip build artifacts and
  archives) for the old name — path-deps and package-qualified imports
  referencing it are now stale. Consumers not gated by the parent's CI
  (e.g. deploy-only targets) can carry the breakage silently for a while.
- **Submodules can nest submodules.** Before planning multi-repo work,
  check `.gitmodules` at every level the edit touches, not just the
  top-level repo. Each distinct upstream repo along the edit path is one
  PR-merge gate — a plan that assumed a 2-PR chain can turn out to need 3+
  once nesting is accounted for. Put the gate count in the plan up front.

## 4. `gh pr merge` / `--delete-branch` pitfalls

- **`fatal: '<default>' is already used by worktree`** fires when the
  default branch is checked out in another worktree (common with
  scheduler/secondary worktrees). The remote-side merge typically still
  completes — add `--admin` if branch protection is what's actually
  blocking the merge; otherwise just re-fetch and check out the default
  branch locally afterward rather than retrying the merge.
- **`--delete-branch` cleanup can fail on either end** when a worktree
  holds the head branch or the default branch, and remote-delete may or may
  not have already run before the failure. Either remove the PR-branch
  worktree first if it's safe to do so, or run `gh pr merge`/`gh pr close`
  and on a local-cleanup error verify state with `gh pr view <N> --json
  state,mergedAt,mergeCommit` before any retry — don't retry a possibly
  already-merged operation blindly. Reconcile local and remote branches by
  hand afterward.
- **Persistent 401s from `gh pr merge`/`gh pr checks` while other `gh`
  calls succeed:** merge via `gh api -X PUT repos/<o>/<r>/pulls/<N>/merge -f
  merge_method=squash`, or the GraphQL `mergePullRequest` mutation as a
  second fallback. Confirm not-yet-merged first with `gh pr view <N> --json
  state,mergedAt,mergeCommit`. Read check status with `gh pr view <N> --json
  statusCheckRollup` — a bare `.name` jq filter silently blanks
  `StatusContext` rows (only `CheckRun` rows have `.name`); use `--jq
  '.statusCheckRollup[] | [(.status // .__typename), (.conclusion //
  .state), (.name // .context)] | @tsv'` instead. Neither API fallback runs
  `--delete-branch`'s cleanup — do that manually once the merge is
  confirmed landed.

## 5. Stacked PR merges (PR B's base = PR A's head)

Two compounding traps:

- **Cascade auto-close.** Merging A with `--delete-branch` deletes A's head
  branch. If B's base was that branch, GitHub auto-closes B immediately —
  and a PR closed this way cannot be reopened or retargeted (`gh pr edit
  --base`, `gh pr reopen` both fail). Retarget B to `main` with `gh pr edit
  --base main` **while A is still open**, before merging A.
- **Squash SHA divergence.** Squash-merging A creates a *new* commit on
  main with a different SHA than A's original commits. B's branch (built on
  A's original commits) now looks like it has commits main doesn't
  recognize. Whether this produces an outright merge conflict or a silent
  clean merge depends on content overlap — verified locally: if A and B
  touch disjoint files, git's 3-way merge reconciles it without complaint;
  if B continues editing something A also touched (the common case in a
  real stack), it's a genuine `CONFLICT (content)`, not just a
  bookkeeping nuisance. Either way, rebase B before merging it: `git
  rebase --onto origin/main A_BRANCH B_BRANCH` drops the now-redundant A
  commits and was confirmed to turn a conflicting merge into a clean
  fast-forward.

Working order down a stack: retarget the next PR to `main` while it's still
open → rebase its branch onto fresh `main` → force-push → merge the current
PR (skip `--delete-branch` if anything downstream still depends on its
branch) → repeat → manually delete any orphaned branches at the end.

## 6. Concurrent-agent safety

Other agents or processes (background Codex runs, parallel sessions) can
operate on the same checkout. Uncommitted work sitting in a shared tree is
not safe from being swept into someone else's commit or reset away.

- Commit or stash finished work to an isolated branch *before* a long
  read-only analysis phase, not after.
- Before any multi-step git surgery (rebase, index manipulation, branch
  splitting), snapshot first: `git diff HEAD > /tmp/backup.patch` plus a
  copy of untracked files. This is the recovery anchor if something else
  touches the tree mid-operation.
- **To undo a throwaway probe in a file that also holds real uncommitted
  edits, do not `git checkout <file>` or `git stash`.** Both operate on the
  whole file (or whole tree), discarding everything uncommitted in it, not
  just the probe. Commit the real work first — `git checkout <file>` is
  then safe because it restores the committed version — or hand-revert only
  the probe line.
- If files outside your task's scope start changing between reads, or `git
  status` churns between your own commands, treat it as a live-concurrent-
  session signal: stop mutating shared branch/HEAD state and verify before
  proceeding, rather than cleaning up under an active process. Any
  git-state observation in a shared checkout is a snapshot, not a durable
  fact — re-verify at the moment of acting, not just when first observed.

## 7. Verify actual state before trusting a claim

- **A commit message is not proof its described change landed.** After a
  squash merge, before writing follow-up work or memory that assumes code
  shipped, run `git diff <sha>^..<sha> -- <file>` and grep for the named
  symbol — a "ghost fix" is a commit message describing a change that was
  never actually staged.
- **A follow-up/tracking issue that cites "already shipped in PR #N" is a
  hypothesis, not ground truth**, until that PR is confirmed `MERGED` via
  `gh pr view <N> --json state,mergedAt` and its commit shows up on the
  target branch (`git branch --contains <sha>`). If the cited PR was closed
  or obviated instead, correct the issue rather than acting on its premise.
- **For "is this package version installable" questions, trust the
  resolver, not the package index page.** Run `moon update` and the
  relevant `moon check`/`moon test` and cite that result — a package's web
  listing can lag behind what's actually published.
- **In a long-lived worktree, `origin/main` can advance underneath you.**
  `git diff origin/main..HEAD` then includes base-drift files you never
  touched, which looks exactly like a stray inclusion. Verified locally: a
  file added by someone else's merge to `origin/main` after your worktree
  was created shows up in `git diff origin/main..HEAD` (as a deletion,
  from your branch's point of view) purely from the base moving — you
  never touched it. `git show --numstat HEAD` (diff against HEAD's own
  parent) is unaffected by this and shows only your true delta. Before
  opening a PR, `git fetch origin main && git rebase origin/main` and
  re-verify (build/tests) on the rebased tree — don't extrapolate from a
  pre-rebase green run.
