---
name: moonbit
description: "Single entry point for all MoonBit skills. Routes to the right specialist based on what you need: code quality, trait design, extensibility, performance, FFI, repo maintenance, etc. Use /moonbit <what you need> instead of remembering individual skill names."
---

# MoonBit Skill Router

Single entry point: `/moonbit <what you need>`

## How to Use

Read the user's request and invoke the matching skill(s) below. If multiple skills apply, invoke them in order.

## Routing Table (8 skills)

| User intent | Invoke skill | Examples |
|-------------|-------------|----------|
| Code smells, idiomatic code, refactoring, deprecated syntax | `moonbit-refactoring` | "is this idiomatic?", "code smell", "clean up", "deprecated?" |
| Error handling, abort vs fail vs raise, error types, boundaries | `moonbit-error-handling` | "should I abort or raise?", "error type design", "FFI error boundary" |
| Trait design, trait patterns, newtypes, opaque types | `moonbit-traits` | "should I use a trait?", "type-safe wrapper", "hide internals" |
| Extensibility, expression problem | `moonbit-expression-problem` | "add new variant", "finally tagless", "extensible data" |
| Performance investigation | `moonbit-perf-investigation` | "optimize", "slow", "bottleneck", "speed up" |
| C FFI bindings | `moonbit-c-binding` | "C library", "extern c", "native FFI" |
| Repo maintenance, lint, sync | `moonbit-housekeeping` | "clean up repo", "lint", "before PR" |
| Pre-commit quality checklist | `moonbit-verification` | "check before commit", "verify code" |

### Supplementary (not routed directly)

| Skill | Purpose | When loaded |
|-------|---------|-------------|
| `moonbit-deprecated-syntax` | Full deprecated syntax reference table | Embedded in `moonbit-refactoring`; standalone for detailed lookup |
| `moonbit-settings` | Claude Code config for MoonBit projects | Only on explicit "set up settings" requests |
| `moonbit:moonbit-agent-guide` | General MoonBit workflow/tooling | Only on explicit "how to use moon" requests |

## Consolidation Notes

- **`moonbit-opaque-types`** merged into **`moonbit-traits`** (opaque types = newtype implementation detail)
- **`moonbit-deprecated-syntax`** merged into **`moonbit-refactoring`** (deprecated syntax = part of "write idiomatic code")
- Both standalone skills still exist for detailed reference, but the router goes through the merged versions

## If Unclear

If the user's intent doesn't clearly match one skill, ask:

> What aspect are you looking at?
> 1. Code quality / idioms
> 2. Type design (traits, newtypes, extensibility)
> 3. Performance
> 4. FFI / bindings
> 5. Repo maintenance

## Combining Skills

Some requests need multiple skills:

- "Review this code" → `moonbit-refactoring` + `moonbit-verification`
- "Design a trait for this" → `moonbit-traits`
- "Make this extensible" → `moonbit-traits` + `moonbit-expression-problem`
- "Optimize this" → `moonbit-perf-investigation`
- "How should I handle errors here?" → `moonbit-error-handling`
- "Should I abort or raise?" → `moonbit-error-handling`
