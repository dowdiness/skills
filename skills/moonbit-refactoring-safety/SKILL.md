---
name: moonbit-refactoring-safety
description: >
  Execution discipline for boundary-crossing MoonBit refactors:
  splitting packages with language-enforced isolation via `internal/`,
  extracting modules behind a `pub using` facade, splitting files
  safely, and pinning invariants with property tests before structural
  change. Use when the task is "split this package", "extract these
  files into an internal package", "verify the public API didn't
  change", or "set up tests before refactoring". Pairs with
  `moonbit-refactoring`, which covers *what* to refactor toward.
---

# MoonBit refactoring safety

Three execution disciplines for refactors where the *direction* is decided but the *transition* is where bugs hide: pre-refactor invariant tests, file splits, and the facade-and-internals package split. Each replaces eyeball verification ("did I move everything? does it still work?") with something the compiler or test runner enforces.

Pairs with `moonbit-refactoring` — that skill covers *what* to refactor toward (idiomatic patterns, API minimization, view types). This one covers *how* to make a mechanical change without regressions.

## Relationship to `moonbit-refactoring`'s package-split section

Upstream `moonbit-refactoring` mentions `internal/` packages as a convention to "consider", and documents a different lightweight package-split flow (using `@A { ... }` in the new package, migrate consumers to it, drop the using). That flow fits the renaming case — when consumers *should* eventually depend on the new package directly.

This skill leads with the **facade + `internal/` extraction** scenario: `A` stays as the public package, internals move into `A/internal/<name>/`, `A` re-exports through `pub using`. MoonBit enforces `internal/` visibility at the language level — downstream modules cannot import `*/internal/*` packages no matter what, so the facade can't be bypassed. Consumers of `A` see no change at the call site, and the boundary is permanent rather than transitional.

If you're hiding internals behind a permanent facade, this skill supersedes the upstream procedure. If you're staging a rename so consumers eventually migrate to the new package, see the "visible-extraction split" variant at the end of section 3 (or upstream's procedure, which fits the same case).

## When to invoke

- "Split this package — hide the implementation but keep the public API stable."
- "Extract these files into an `internal/` package."
- "Move this code so downstream can't depend on it directly."
- "Set up a safety net before I refactor this."
- "I refactored X; how do I verify the public API didn't change?"

If the task is "refactor this code to be more idiomatic" (rename, pattern matching, method conversion, loop style), use `moonbit-refactoring` instead — those changes are local and the compiler catches the breakage. This skill kicks in when the change touches *boundaries* (files, packages, public API).

## 1. Safety net: property tests before structural changes

Before a refactor that crosses a file or package boundary, write property tests that pin the behavioral invariants the refactor must preserve. Once the structure moves, the test suite should tell you what broke. This is strongly recommended for any refactor that touches non-trivial behavior; skip it only for purely mechanical extractions of pure code where the invariant ("this function still returns the same value") is obvious from the type.

Verified pattern using `moonbitlang/core/quickcheck`:

```mbt
test "encode/decode round-trip" {
  let cases : Array[Array[Int]] = @quickcheck.samples(100)
  for xs in cases {
    let encoded = encode(xs)
    let decoded = decode(encoded).unwrap()
    assert_eq(decoded, xs)
  }
}
```

Add to the package's `moon.pkg` to enable `@quickcheck`:

```
import {
  "moonbitlang/core/quickcheck" @quickcheck,
}
```

**Generator discipline:**
- `@quickcheck.samples(N) : Array[T]` produces `N` random values of any `T : Arbitrary`. Built-in `Arbitrary` impls exist for `Unit`, `Bool`, `Byte`, `Char`, `Int`, `Int64`, `UInt`, `UInt64`, etc. and for collections of those.
- If a sample needs validation (e.g., a `Pos` that rejects negatives), call the validating constructor and `unwrap()` — **never** write `Err(_) => return` or `None => continue` to silently skip. A silently-skipped sample turns the property test into a no-op that passes for the wrong reason; refactors then break under load and the tests don't notice.
- If valid inputs are hard to generate, that itself is a refactor smell — the constructor is doing too much or the invariants aren't where they should be.

**Why this step matters for boundary refactors:** unit tests pin local behavior, but boundary refactors change *which side* of a boundary owns a piece of logic. The unit test that exercised the old owner may pass against the new owner for the wrong reason (different code path, same answer). Properties cross the boundary; unit tests do not.

> **Verified:** `@qc.quick_check_fn` does **not** exist in `moonbitlang/core/quickcheck`. Earlier MoonBit refactoring guidance referenced it; if you see that name in older docs, it was either a project-specific helper or aspirational. The actual API is `gen` (single value) and `samples` (Array). Build a property test by iterating over `samples`.

## 2. File splits: delete-first technique

When splitting a large `.mbt` file into smaller focused files within the same package, **delete the original after extracting the sections**, then run `moon check`. The compiler will enumerate every missing definition. This is faster and more reliable than verifying line-range extractions by counting.

```bash
# 1. Extract sections into new files (parser_lex.mbt, parser_parse.mbt, etc.)
# 2. Delete the original
rm parser.mbt
# 3. Let the compiler report everything still referenced
moon check
# Each "value identifier X is unbound" / "type Y not found" tells you exactly
# what didn't make it into a new file.
```

**Never** verify a file split by comparing line counts (`wc -l` before/after, "the totals match"). A line count match proves nothing — you can have duplicated content in two files, or have moved comments while losing code, and the counts will agree.

This works because MoonBit treats files within a package as organizational units, not separate modules. A symbol moved between files in the same package needs no import update. The compiler either finds it or reports the missing symbol, which is the signal you need.

**When to skip:** if the file is small enough to read top-to-bottom in one screen, just move it and verify visually. The delete-first technique pays off when the file is large enough that you can't trust a visual scan.

## 3. Facade + internals package split: six steps

Splitting package `A` (the existing public package) by extracting its internals into a new package located under `A/internal/`. `A` becomes a thin facade re-exporting the internal package's public surface, so existing consumers continue compiling unchanged — **and**, because MoonBit enforces `internal/` visibility at the language level, downstream consumers cannot bypass the facade by importing the internals directly. Each step exposes one specific failure mode.

> **The `internal/` rule is language-enforced.** Any package whose path contains a segment named `internal` (e.g. `dowdiness/myproj/internal/store`) can only be imported by packages within the *same module*. An external module attempting `import { "dowdiness/myproj/internal/store" }` is rejected by `moon` at the build-plan phase, before `moonc` even runs, with:
>
> ```
> Cannot import internal package dowdiness/myproj/internal/store@0.1.0
>   in dowdiness/other-module@0.1.0 due to internal visibility rules
> ```
>
> This is the load-bearing reason to put extracted internals under `internal/` rather than alongside the facade as a sibling package. The compiler — not your code review discipline — guarantees the facade can't be bypassed.

### Step 1 — Create `A/internal/<name>`, move source files

Create the directory `A/internal/<name>/` (pick a descriptive `<name>` for the extracted package, e.g. `internal/store`). Add an empty package manifest — either `moon.pkg` or `moon.pkg.json` is valid; `moon new` generates the `.json` form, but a literally-empty `moon.pkg` is enough to declare the package. Move the relevant source files into the new directory. Do not yet touch `A`'s manifest.

(If your goal is a *renaming-style* split where consumers should eventually depend on the new package directly, put it at a sibling path like `dowdiness/myproj/B` instead of under `internal/`. The procedure below is otherwise identical; the only behavioral difference is that consumers can migrate to `@B.X` over time. See "Variant: visible-extraction split" at the end of this section.)

### Step 2 — Re-export via `pub using` in the facade

In `A`'s `moon.pkg`, add the internal package as a dependency. Then in an `.mbt` file inside `A`, re-export the internal package's public surface:

```mbt
// In package A — backward-compatible re-export
pub using @internal_store {
  type MyType,       // structs, enums (methods/associated fns/constructors come along)
  trait MyTrait,     // traits
  my_function,       // functions and constants
}
```

`pub using` does two things at once: re-exports to consumers of `A`, **and** makes the names available locally inside `A` without the `@internal_store.` prefix. Code remaining in `A` keeps compiling unchanged. Run `moon check` after this step.

**What re-exports automatically** (verified with `moon check` and `moon info`). Listing `type Foo` re-exports the type *and* all of its methods, associated functions, and custom constructor. From a consumer's perspective:

```mbt
let s : @A.MyType = @A.MyType()   // custom constructor through facade
s.method()                         // method through facade
```

both work without listing `MyType::method` or `MyType::MyType` separately. Listing the type pulls its methods along. Functions, constants, and traits must be listed by name.

**`pub using` forwards names, not permissions.** A `pub struct S` is read-only to external code. Fields are readable, but external code cannot construct `S::{...}` or write `mut` fields. Re-exporting preserves that visibility, so consumers of `@A` see the same access they would see importing directly from the internal package. If external construction or field mutation is required, declare the origin as `pub(all) struct S`, or expose a constructor / mutator method.

### Step 3 — Expect private-symbol errors

After steps 1 and 2, `moon check` will report errors at every private function inside the internal package that used to live next to its caller (which is now in `A`). The error reads as **"Value X not found in package <internal-name>"**. The compiler treats private symbols as if they do not exist from outside, rather than emitting a separate "private" diagnostic. The split exposes hidden coupling that was invisible while everything lived in one package.

Fix by making necessary functions `pub` in the internal package. `A` can then use them through `pub using` or directly via the `@internal_store.` prefix. The `internal/` rule keeps those `pub`s inside the module, so they do not leak to downstream consumers.

**Note on direction:** errors flow `A → internal` (caller now in `A`, callee private in the internal package). The reverse direction (internal package calling something private in `A`) cannot occur — that would require the internal package to import `A`, but `A` already imports it, and the compiler hard-rejects the cycle with **"Import loop detected"**. Internals never depend on facade.

Let step 3 surface the needed `pub` changes. Publishing everything in step 1 hides the inventory of what needs to cross the boundary, usually a smaller set than you would guess.

**Enums and structs add a second error class:** `pub` enum/struct constructors
are **read-only outside the defining package** (error [4036] "Cannot create
values of the read-only type"), so construction sites left in the facade break
even though pattern matches survive. Before widening to `pub(all)`, check where
construction sites live in the *end state* of the refactor — if they move into
the new package too, the widening is only needed mid-refactor and should be
reverted in the final pass (validated: canopy S2, PR #583).

### Step 4 — Verify `.mbti` stability

Run `moon info` and inspect `git diff A/pkg.generated.mbti`. The interface file is the source of truth for what consumers of `A` see.

Verified `.mbti` shape after re-exporting `type Store, put` from `@internal_store`:

```
// A/pkg.generated.mbti (excerpt)
import { "internal/store" }

// Values
pub fn put(@store.Store, String, Int) -> Unit   // function: inlined with origin types

// Type aliases
pub using @store {type Store}                    // type: under "Type aliases" section
```

Functions get inlined as ordinary forwarded signatures whose parameter and return types reference the canonical origin. Types land in the `Type aliases` section of the `.mbti` as `pub using @origin {type Name}` lines. Consumer code written against `@A.Store` / `@A.put` still compiles unchanged.

If the `.mbti` diff shows any change you didn't intend (a removed symbol, a changed signature, an unexpected origin path), the split has leaked. Stop and fix before continuing.

### Step 5 — Verify external isolation

A defining feature of the `internal/` split: downstream code cannot reach the internal package even if it tries. Verify with a quick smoke test from a consumer module:

```moonbit
// In a downstream module
import { "dowdiness/myproj/internal/store" @store }
// Build fails: "Cannot import internal package ... due to internal visibility rules"
```

If this *succeeds*, something is wrong. Check that the path contains a literal `internal` segment, and that the consumer is in a different module rather than a different package within the same module.

### Step 6 — Audit and trim the facade

Walk the facade with `moon ide analyze` and remove any `pub using` entry that ended up unused, plus any `pub` in the internal package that no longer has a caller in `A`. Unlike a visible-extraction split, consumers are expected to keep using `@A.X`. The `internal/` boundary is permanent, so the facade's `pub using` block is the long-term API surface rather than a transitional shim.

### Variant: visible-extraction split (for renaming/restructuring)

If the goal isn't to *hide* the internals but to *rename* the package so consumers eventually depend on the new path directly, drop the `internal/` segment and put the extracted package at a sibling path (e.g. `dowdiness/myproj/B`). The first four steps are identical. Steps 5 and 6 change:

- **Step 5':** Migrate consumers incrementally with `moon ide find-references <symbol>`. The facade's `pub using` is a transitional shim — consumers can switch from `@A.MyType` to `@B.MyType` at their own pace.
- **Step 6':** Once all known consumers have migrated, remove the corresponding entries from `A`'s `pub using` block. Eventually the facade may disappear entirely.

This variant loses the language-enforced isolation in exchange for migration flexibility. Use it only when consumers *should* eventually depend on `B` directly.

## Modern loop-expression notes during safety refactors

When adding safety tests or doing small mechanical rewrites as part of a boundary refactor, consider MoonBit's loop-expression forms for loops that naturally compute a value. Treat this grammar as a precision tool, not as the default replacement for every mutable loop: it gives imperative code functional result shape without pretending effects do not exist.

MoonBit `for` loops are expressions, so binding their result is valid and idiomatic:

```mbt
let total = for x in xs; acc = 0 {
  continue acc + x
} nobreak {
  acc
}
```

Good candidates are loops whose primary purpose is the returned value:

- sum/count/fold accumulators
- `any`/`all` scans, especially with early `break`
- min/max/peak searches
- small tuple accumulators where multiple counters move together
- search-with-default-result patterns

```mbt
let found = for x in xs {
  if predicate(x) {
    break true
  }
} nobreak {
  false
}
```

The update clause can use variables introduced by an `is` pattern in the condition clause:

```mbt
let total = for sum = 0; queue.next() is Some(elem); sum = sum + elem {
} nobreak {
  sum
}
```

Prefer ordinary imperative loops when the loop is primarily procedural or side-effect-driven:

- filling, copying, or mutating buffers/arrays/maps
- parser cursor movement or state machines
- graph/DSP hot loops unless the rewrite is clearly allocation-neutral and simpler
- loops where the boolean/count is only a side product of many side effects
- loops that become more verbose through repeated `continue same` / `continue did_find` ceremony

Use loop expressions only when they make the safety check or extraction clearer. Do not broaden a boundary-refactor PR just to restyle unrelated loops; keep loop-expression rewrites local to code already being touched or to tests added as the safety net.

## Commands quick reference

```bash
moon check                                  # surface private-symbol errors and missing defs
moon info                                   # regenerate .mbti
git diff <pkg>/pkg.generated.mbti           # verify only intended interface changes
moon ide find-references <symbol>           # enumerate call sites for migration
moon ide analyze <pkg> | grep "can be removed"   # find over-exposed pub after migration
```

## See also

- `moonbit-refactoring` — the upstream skill: *what* to refactor toward (API minimization, pattern matching with views, method conversion, loop forms), plus the shared-utilities package-split variant.
- `moonbit-verification` — the post-change quality checklist: typecheck, tests, `.mbti` audit, formatting. Run after each safety-step above.
