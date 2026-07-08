---
name: moonbit-gotchas
description: >
  Use when writing MoonBit code involving derive(Debug) on container
  fields, a trait method whose name matches a callable field, JS-target-only
  public APIs or JS numeric formatting, `guard` early-exit syntax, package
  visibility (`pub` vs `pub(all)`) on mutable-container fields, or `moon
  fmt` touching a comment-only or multi-line closure body — silent-failure
  compiler/formatter behaviors that `moon check` and `moon fmt` don't flag.
---

# MoonBit silent-failure gotchas

## Overview

A catalog of MoonBit compiler and formatter behaviors that fail **silently**
— code compiles clean, formats clean, and passes `moon check`, but doesn't
do what it visually suggests. This complements two other skills rather than
duplicating them:

- **REQUIRED SUB-SKILL for idiomatic style** (match over `.is_some()`,
  guard-based early exit, iterator chains, array/view pattern matching,
  custom-constructor call syntax): `moonbit-refactoring`.
- **REQUIRED SUB-SKILL for the deprecated-syntax table**:
  `moonbit-deprecated-syntax`.

Several entries below are version-stamped where known; MoonBit's compiler
moves quickly, so re-verify an unstamped entry against your `moonc` version
before relying on it long-term.

## Trait method / closure-field name collision

If a trait method shares a name with a callable (closure-typed) field on
the implementing type, `self.field(args)` inside that trait impl parses as
a **recursive call to the trait method itself**, not a field access —
infinite loop at runtime, with no compile-time signal (the call's return
type matches the trait method's, so type checking passes clean).

```moonbit
priv struct SlotMeta {
  push_revised_at_for : (CellId) -> Revision  // closure field
}

impl SlotSnapshot for SlotMeta with push_revised_at_for(self, cell_id) -> Revision {
  self.push_revised_at_for(cell_id)   // INFINITE LOOP: resolves to the trait method, not the field
}
```

Fix: bind the field to a local name first (or parenthesize explicitly:
`(self.push_revised_at_for)(cell_id)`, though that's an easy-to-undo
parser subtlety):

```moonbit
impl SlotSnapshot for SlotMeta with push_revised_at_for(self, cell_id) -> Revision {
  let f = self.push_revised_at_for
  f(cell_id)
}
```

Only *callable*-field collisions are dangerous — a `Bool` field shadowed by
a same-named trait method parses as plain field access (no call suffix), no
recursion. When adding a trait whose methods might collide with field names
on an implementor, exercise at least one call through `&Trait` dispatch in
tests, not just the concrete-struct path — the collision can hide behind
tests that only exercise the direct path.

## `derive(Debug(ignore=[...]))` only filters top-level field types

`ignore=[...]` matches a field's declared type exactly — it does not look
inside containers. Verified on moonc 0.1.20260629: given `type Fn = () ->
Unit` and `struct S { hooks : Array[Fn]; n : NoDebug } derive(Debug(ignore=
[NoDebug, Fn]))`, `ignore` successfully suppresses the error for `n :
NoDebug` (a direct field-type match) but **not** for `hooks : Array[Fn]` —
the field's own type is `Array`, not `Fn`, so `Fn` in the ignore list never
matches it. `moon check` still fails with `Type () -> Unit does not
implement trait ... Debug`.

Fix: for structs with non-`Debug` types nested inside `Array`/`Option`/etc.,
write a manual `pub impl Debug for T with to_repr(self)` instead of relying
on `ignore`.

## JS-only public APIs need `preferred_target`, not just `--target js`

`moon info --target js` reports what the JS backend interface *would* look
like, including `#cfg(target="js")`-gated functions — but it does not
change which backend actually gets written to the checked
`pkg.generated.mbti`. That's controlled by the package's/module's
`preferred_target`, falling back to the workspace's preferred target,
falling back to `wasm-gc`.

For a package exposing js-only public APIs consumed by other js packages:
set `preferred_target = "js"` on that package/module, then run `moon info`
and commit the regenerated `pkg.generated.mbti`. Running `moon info
--target js` alone leaves the checked interface stale (missing the js-only
functions) even though the inspection command reported them present.

## JS numeric behavior is worth proving, not assuming

`Int64` division, `to_string`, and float formatting can in principle differ
across native/wasm and JS targets (JS `Number` precision). If code with
fixed-input deterministic tests ships to a JS target, settle the question
empirically:

```bash
NEW_MOON_MOD=0 moon test --target js -p <pkg>
```

This is cheap and turns a "might differ on JS" review comment into a proven
pass or fail, rather than leaving it as an assumption in either direction.

## `guard` early-exit syntax

The compiling form is `guard <expr> is <Pattern> else { ... }`. The
superficially similar `guard let <Pattern> = <expr> else { ... }` does
**not** work as an early-exit binder. Verified on moonc 0.1.20260629, it is
now a **hard compile error**, not a silent pass-through: `Expr Type
Mismatch` (the let-statement's `Unit` type doesn't satisfy the `Bool` guard
condition expects), `Using let statement in 'let' directly is not allowed`,
and an unbound-identifier error for the pattern binding once the body tries
to use it. Earlier accounts of this trap described the binder as silently
failing to escape the guard's scope — that specific silent-failure
characterization does not match this compiler version, but the fix is the
same regardless of which failure mode you hit: rewrite to `guard ... is
... else`. The compiler's own errors don't suggest that fix, so don't
assume from the error text alone that a different `let` variant is the
answer.

## `is-internal` is not a real moon.pkg field

There is no `is-internal`/`is_internal` field in moon.pkg. If a reviewer
(human or AI) suggests adding one to mark an `internal/` package as
non-importable externally, reject it — MoonBit's visibility mechanism for
internal packages is the `internal/` **directory path segment** itself
(compiler-enforced, Go-style convention), not a config flag. Verify by
grepping the MoonBit stdlib (`~/.moon/lib/core/**`, which has dozens of
`internal/*` packages) for the string — zero hits.

## `pub` closes construction only, not interior mutation

Narrowing a struct from `pub(all)` to `pub` blocks external struct-literal
construction, but field *reads* still work — and reading a
mutable-container field (`Array`, `HashMap`) returns a **live, mutable
reference**. External code can still call `.push(...)` or otherwise mutate
through that reference, even though the type "looks" closed. Only
`Int`/immutable-value fields are safe under plain `pub`, because reads of
those copy.

The real closure mechanism is **field-level `priv` inside a `pub`
struct** (renders as `// private fields` in `.mbti`). For accessors that
return a stored mutable container, return `.copy()`, or document the
aliasing deliberately. See `moonbit-opaque-types` for the encapsulation
pattern this extends.

When specifying what a visibility change should close off, verify with a
**known-positive probe**: write the forbidden code (literal construction,
and separately, mutation through each mutable-container field) and confirm
the compiler rejects both. An `.mbti` diff alone won't surface the
interior-mutation hole — it only reflects what's constructible, not what's
still mutable through a returned reference.

## `moon fmt` can delete comments, and reformats multi-line arrow bodies

- A closure body containing only `//` comments is treated as empty and
  collapsed to `fn() {  }` — **deleting the comments**. Don't accept this
  diff. Move the comment above the enclosing call/statement and write the
  body as the conventional empty callback `() => ()`. Verify idempotence
  with `moonfmt <file> | diff <file> -`. (Observed on moonc v0.10.x.)
- `x => expr` (no braces) is only stable when the whole expression fits on
  one line. Any multi-line body gets rewritten to `x => { ... }` with
  braces added on the next `moon fmt` pass — write multi-line lambda
  bodies with braces from the start to avoid formatter churn on the next
  run.
