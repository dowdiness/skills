# Skills

Installable skills live in this directory. Each skill is a directory with a `SKILL.md` entry point.

## Catalog

| Skill | Origin | Purpose |
|---|---|---|
| `moonbit` | manual | Router for the MoonBit skill family. |
| `moonbit-agent-guide` | vendor | MoonBit coding, layout, and tooling guide. |
| `moonbit-c-binding` | vendor | Native C binding and FFI guide. |
| `moonbit-refactoring` | vendor | Idiomatic MoonBit refactoring guide. |
| `moonbit-agent-setup` | vendor | Project instructions for Codex, Claude Code, and generic agents. |
| `moonbit-deprecated-syntax` | vendor | Deprecated MoonBit syntax and replacements. |
| `moonbit-error-handling` | vendor | Error type, abort/fail/raise, and recovery-boundary guidance. |
| `moonbit-expression-problem` | vendor | Finally Tagless and two-layer extensibility patterns. |
| `moonbit-housekeeping` | manual | Repo maintenance workflow with BAML-backed worker-output parsing. |
| `moonbit-opaque-types` | vendor | Opaque/newtype public API patterns. |
| `moonbit-perf-investigation` | vendor | Measurement-first performance workflow. |
| `moonbit-refactoring-safety` | vendor | Safety discipline for boundary-crossing refactors. |
| `moonbit-traits` | vendor | Practical patterns for MoonBit's Self-based trait system. |
| `moonbit-verification` | vendor | MoonBit quality checklist. |
| `incr` | vendor | Guidance for the `dowdiness/incr` reactive library. |
| `loom` | vendor | Guidance for the `dowdiness/loom` parser framework. |
| `handoff` | manual | End-of-session memory and next-session prompt ritual. |
| `orchestrate` | manual | Cross-repo and multiagent session setup. |
| `tuple-wrapper-api-style` | manual | Tuple wrapper API style guidance. |

## moonbit-housekeeping dependency

`moonbit-housekeeping` includes `parse-worker-output.py`, a JSON validator powered by BAML (`baml-lib`). It runs through `uv` using inline PEP 723 dependencies.

Install `uv` with one of:

```bash
brew install uv
curl -LsSf https://astral.sh/uv/install.sh | sh
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Smoke test:

```bash
skills/moonbit-housekeeping/parse-worker-output.py \
  --root Changelog \
  --input skills/moonbit-housekeeping/tests/a1-changelog-clean.txt
```

Regression tests live at `skills/moonbit-housekeeping/tests/run-tests.nu`.
