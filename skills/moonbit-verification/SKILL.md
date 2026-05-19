---
name: moonbit-verification
description: >
  Quality checklist for MoonBit development. Use when implementing or
  modifying MoonBit code to catch dependency issues, syntax mistakes,
  test failures, CLI bugs, and interface changes before they become
  problems.
---

# MoonBit Development Verification Skill

**Trigger**: Use this skill when implementing or modifying MoonBit code to ensure quality and catch common issues early.

## Pre-Implementation Phase

### 1. Dependency Health Check
Before starting any implementation:
- Run `moon update` to refresh dependencies
- Attempt a clean build with `moon check` to verify all dependencies are available
- If any moonbitlang/x or other external packages fail, **stop and report the issue** with:
  - Exact dependency name and version
  - Error message
  - Suggested workarounds (vendoring, alternative packages, or implementing the functionality directly)
- Do not proceed with implementation if dependencies are broken

### 2. MoonBit Syntax Pattern Verification
When implementing new code, be especially careful with:
- **Tuple destructuring**: Use correct syntax `let (a, b) = tuple` not `let a, b = tuple`
- **Labelled arguments**: Follow MoonBit conventions for named parameters
- **Error handling**: Use Result types and pattern matching correctly
- **Error messages**: Ensure string formats in errors match test assertion expectations exactly

### 3. Deprecated Syntax Awareness
Avoid these deprecated patterns that trigger warnings (treated as errors by CI):
- `inspect!(...)` → use `inspect(...)` (bare form, no `!` suffix)
- `not(expr)` → use `!expr`
- `'\x0C'` char literal → use `'\u000C'` (use `\u` prefix, not `\x`)
- `Char::from_int(n)` → use `n.unsafe_to_char()` (or `n.to_char()` for safe)
- `UInt::to_int()` → use `UInt::reinterpret_as_int()`
- `derive(Show)` → deprecated [0027]; use `derive(Debug)` for debugging, add manual `impl Show` if `inspect()` is needed
- `derive(Show, Eq)` on private enums whose impls are unused → remove the derive, or suppress with `warnings = "-1"`
- `typealias` → use `pub type X = Y` or `pub using @pkg { type X }`
- Test-only imports: use `import { "pkg" @alias } for "wbtest"` (not in the main `import` block)

## Implementation Phase

### 4. Multi-File Change Coordination
When changes span multiple files:
- Read all affected files first before making changes
- Ensure import statements are correct across files
- Verify type signatures are consistent
- Check that `.mbti` interface files will be updated correctly

### 5. Test-First Verification
Before marking any feature complete:
- Run `moon test` and capture the full output
- **For each test failure**:
  - Show expected vs actual output
  - Identify the root cause (syntax error, logic bug, or assertion mismatch)
  - Fix the issue
  - Re-run that specific test to verify
- **Verify error message formats** match test assertions character-for-character
- If tests use snapshot testing (`inspect`), consider whether behavior change is intentional
- Only proceed when ALL tests pass

### 5a. Property Test Quality (when using `@qc.quick_check_fn`)
Property-based tests need their own verification:
- **Generators must crash, not skip.** If a generator is documented as producing valid inputs, use `unwrap()` on compile/construct results. Never `None => true` — that hides generator bugs as false positives.
- **Check generator distribution.** After writing generators, verify they actually produce the topology/variant classes you care about. A generator that "covers all cases" but never hits a critical path (e.g., feedback cycles, stereo delay) gives false confidence.
- **Review test generators like production code.** Generator blind spots are test blind spots.

### 6. CLI Functional Testing (if applicable)
If implementing a CLI tool or demo app, manually verify:
1. Run `--help` at root level - check output formatting
2. Run `--help` for each subcommand - verify correct help text
3. Test each flag individually - ensure they work as expected
4. Test flag combinations - check for shadowing issues (e.g., global `-v` vs subcommand `-v`)
5. Verify error messages for invalid inputs match expected format
6. Test edge cases (missing required args, invalid values, etc.)

## Post-Implementation Phase

### 7. Interface and Format Verification
After all tests pass:
- Run `moon info` to update `.mbti` interface files
- Check `git diff *.mbti` to verify API changes are intentional
- Review any unexpected interface changes and explain why they occurred
- Run `moon fmt` to format code consistently
- Run final `moon check` to ensure no lint issues

### 8. CI-Matching Checks (critical — do this before pushing)
The CI uses stricter settings than bare `moon check`. Run the exact CI commands:
```bash
make check      # runs moon check --deny-warn (all warnings → errors)
make fmt-check  # runs moon fmt and diffs (any formatting drift → failure)
moon test       # or: make test (runs moon test --release)
```
If `make` targets aren't available, the equivalent commands are:
```bash
moon check --deny-warn    # warnings are errors
moon fmt                  # then check: git diff --exit-code
moon test --release
```
**Common CI failures:**
- `derive(Show)` is deprecated [0027] — use `derive(Debug)`, add manual `impl Show` only where `inspect()` requires it
- `derive(Show, Eq)` on private types whose impls are unused → remove derive
- Deprecated syntax (see section 3) → use modern equivalents
- Formatting drift → always run `moon fmt` after edits
- Test-only imports in main import block → use `import { ... } for "wbtest"`

### 9. Benchmark Verification (for performance-critical code)
If modifying performance-critical paths:
- Run `moon bench --release` (always with --release flag)
- Compare results to baseline if available
- Report any significant performance changes

### 10. Performance Optimization Gate
**If the task is a performance optimization**, use the `moonbit-perf-investigation` skill BEFORE designing any solution. That skill requires reproducing the claimed bottleneck in an isolated microbenchmark. Do not skip this — stale profiling data and O(bad) complexity are not proof of a real problem.

## Quality Checklist

Before marking the task complete, verify:
- [ ] Dependencies are healthy and build succeeds
- [ ] All MoonBit syntax patterns are correct (no deprecated patterns)
- [ ] All tests pass with exact assertion matches
- [ ] CLI functionality tested manually (if applicable)
- [ ] Interface files (`.mbti`) updated and reviewed
- [ ] Code formatted with `moon fmt`
- [ ] `make check` passes (--deny-warn, zero warnings)
- [ ] `make fmt-check` passes (no formatting drift)
- [ ] Multi-file changes are coordinated and imports are correct

## Error Recovery

If you encounter compilation errors:
- Show the exact error message
- Identify if it's a syntax issue, dependency problem, or logic error
- Attempt a fix using correct MoonBit idioms
- If the error is unclear or seems like a dependency issue, **stop and ask** rather than guessing

## Notes

This skill addresses common friction points:
- Broken dependencies causing wasted iteration
- MoonBit syntax issues (labelled args, tuple destructuring, deprecated patterns)
- Test assertion format mismatches
- CI failures from `--deny-warn` treating warnings as errors
- Formatting drift between local and CI environments
- Test-only imports polluting main import blocks
- Functional bugs in CLI tools (help text, flag shadowing)
- Interface changes not being reviewed

Use this checklist to catch issues before they require debugging cycles.
