---
name: gh-cli-markdown-quoting
description: >
  Use when creating or editing a GitHub PR/issue body, comment, or commit
  message from a shell, or when writing a grep/rg search pattern —
  especially if the Markdown or pattern contains backticks, `$()`, `>`, or
  other shell metacharacters that could be expanded before the tool sees
  them.
---

# GitHub CLI Markdown quoting

## Overview

Markdown commonly contains backticks, `$()`, `>`, and quotes. When that text
passes through a shell as an inline `--body "..."` argument or an
unquoted/double-quoted heredoc, the shell interprets those characters —
command substitution, redirection — **before** `gh` (or `rg`/`grep`) ever
sees the string. The result: mangled PR/issue bodies, phantom files created
by stray redirects, or search patterns that silently run commands instead of
matching text.

## The fix

Write the body to a temp file with a **single-quoted heredoc delimiter**
(`<<'EOF'`, not `<<EOF`) so the shell never expands its contents, then pass
the file to the tool:

```bash
cat > /tmp/pr-body.md <<'EOF'
## Summary
- Mentions `@scope.binder_span` and runs `moon check` — safe, it's just text now.
EOF
gh pr create --body-file /tmp/pr-body.md
# or: gh pr edit <N> --body-file /tmp/pr-body.md
# or: gh issue create --body-file /tmp/issue-body.md
# or: gh issue comment <N> -F /tmp/issue-comment.md
```

Prefer a dedicated file-writing tool over a heredoc when one is available —
it writes the exact bytes with no shell involved at all.

## Gotchas

- **`--body-file -` (stdin) is not a substitute for a real file.** It's
  still shell plumbing, not a verifiable artifact — it has been observed to
  report success while leaving the body empty under some wrapper tooling.
  Write an actual file and pass its path.
- **Don't write the body file inside a submodule's `.git/`.** In a
  submodule checkout, `.git` is a *file* (a gitdir pointer), not a
  directory — writing there fails with `ENOTDIR`. Use `/tmp/` instead.
- **Local commit/PR hooks can substring-match the raw command text, not
  just real invocations.** A hook that blocks Bash commands containing a
  flagged token (e.g. a build-tool subcommand name) often can't distinguish
  a real invocation from that token appearing inside a quoted commit
  message or PR body — prose that mentions "ran `X check`" can trip the
  same guard as actually running `X check`. Route the body through a file
  (`git commit -F /tmp/msg`, `gh ... --body-file`) so the flagged token
  never appears in the literal Bash command the hook scans. The same
  applies to read-only commands: a `grep`/`rg` pipeline whose *pattern*
  contains the flagged token trips the guard too.
- **The same shell-expansion trap hits search patterns, not just PR
  bodies.** A double-quoted `rg`/`grep` pattern containing a Markdown
  code-span (`` `fn` ``) executes the backticked text as a command before
  the search tool ever sees it. Single-quote the pattern, or pipe it
  through a pattern file:
  ```bash
  rg -n 'typed-`fn`|source scanner' docs
  printf '%s\n' 'typed-`fn`' | rg -n -f -
  ```

## Verify after writing

Don't assume a non-error exit means the body rendered correctly — confirm
it:

```bash
gh pr view <N> --json body
gh issue view <N> --json body
gh api repos/<owner>/<repo>/issues/comments/<id> --jq .body
```
