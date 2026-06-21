---
name: moonbit-deprecated-syntax
description: Tracks deprecated MoonBit syntax to avoid generating invalid code. Reference this before writing MoonBit code. Auto-maintained when deprecated patterns are discovered.
---

# MoonBit deprecated syntax

Reference this skill before writing MoonBit code. Using deprecated syntax causes warnings, and CI configurations with `-w @a` (warnings as errors) will fail.

## Deprecated patterns

| Deprecated | Replacement | Notes |
|-----------|-------------|-------|
| `tuple._` | `tuple.0`, `tuple.1` | Positional index, not underscore |
| `opt.is_some()` | `opt is Some(_)` | Use `is` pattern matching |
| `opt.is_none()` | `opt is None` | Use `is` pattern matching |
| `opt.is_empty()` on Option | `opt is None` | Use `is` pattern matching |
| `supported-targets` in moon.pkg.json | Per-file conditional compilation | Use `*_js.mbt`, `*_wasm.mbt` suffixes |
| `inspect!(expr)` | `inspect(expr)` | Bang syntax deprecated |
| `map.size()` | `map.length()` | Use `.length()` for all collections |
| `opt.or(default)` | `opt.unwrap_or(default)` | `.or()` deprecated |
| `text.substring(start=i, end=j)` | `text[i:j].to_string()` | Slice syntax preferred |
| `try? expr` | `try <expr> catch { e => ... } noraise { _ => ... }` | `try?` is deprecated; migrate to explicit catch/noraise around the raising expression |
| `pub typealias X = Y` | `pub type X = Y` | `typealias` keyword removed |
| `let UPPER_CASE` at module level | `let lower_case` | Uppercase requires `const`, not `let` |
| `not(expr)` | `!expr` | Use prefix `!` operator |
| `else { ... }` in for-loop nobreak | `nobreak { ... }` | `else` deprecated for nobreak blocks |
| `loop (xs, 0) { ... => continue ... }` | `for` + `match` with state variables | `loop` keyword being removed |
| `derive(Show)` | `derive(Debug)` + manual `impl Show` if needed | `derive(Show)` warns [0027]; `Show` trait itself is NOT deprecated — `inspect()` still requires it. Use `derive(Debug)` for debugging; add manual `impl Show` for `inspect`/`to_string` (v0.9) |
| `lexmatch`/`lexmatch?` | `s =~ re"..."` regex expressions | Planned removal; use stable regex syntax (v0.9) |
| `@immut/array` | `@immut/vector` | `immut/vector` replaces `immut/array` with better performance (v0.9) |
| `type T UnderlyingType` newtype | `struct T(UnderlyingType)` | Old newtype syntax removed in v0.9.2 — use single-field tuple struct |
| Mutually recursive local `fn` | `letrec` | Mutually recursive local `fn` declarations removed in v0.9.2; use `letrec` for local mutual recursion |
| Dual-signature struct constructor | `fn Type::Type(params) -> Type { .. }` | The verbose two-declaration form is deprecated in v0.9.2 — define the constructor directly as one method |
| Struct factory `Type::new(...) -> Type` for construction | custom constructor `fn Type::Type(...) -> Type` and call `Type(...)` | Prefer MoonBit's custom struct constructor syntax for struct values; reserve named factories for non-constructor alternatives like `from_bytes`, `open`, or `load` |
| `Show::to_string` on Option / Result / Array / Map / Set / tuple | `Debug::to_string` (via `derive(Debug)`) + `@debug.assert_eq` | Container `Show` impls being phased out per v0.9.2 release notes. Verified deprecation observed on `Option` in `moonc` 0.1.20260427; broader container deprecations may not have shipped yet — check `moon check` output. `Show::output` is now consistent with `Show::to_string` (both unquoted) for `String`/`Char` |
| `options("pre-build": ...)` in moon.pkg | `rule()` / `dev_build()` in `moon.mod` | v0.9.2 build rules: structured `rule()` / `dev_build()` declarations are reusable across packages |

## try? migration examples

### Map `try?` to `Result`-style handling

```moonbit
// DEPRECATED
// let result : Result[Unit, Error] = try? rt.batch(fn() raise {
//   // ...
// })

// REPLACEMENT (result-preserving)
let run = fn() raise {
  rt.batch(fn() raise {
    // ...
  })
}
let result : Result[Unit, Error] = try run() catch {
  e => Err(e)
} noraise {
  _ => Ok(())
}
```

```moonbit
// REPLACEMENT (local assertion)
let mut failed = false
try
  do_something_that_may_raise()
catch {
  _ => failed = true
} noraise {
  _ => ()
}
```

## API patterns

| Don't use | Use instead | Notes |
|-----------|-------------|-------|
| `map[key]` for lookup | `map.get(key)` | `map[key]` calls `at()` which panics on missing key |
| `map[key]` is fine for SET | `map[key] = value` | Setting values with `[]` is correct |
| `@math.ln(x)` | `@math.ln(x)` | Method `.ln()` doesn't exist on Double |
| `Array::init(n, fn)` | `Array::makei(n, fn)` | Check which is available |

## Loop syntax guide

```moonbit
// DEPRECATED — being removed
loop (xs, 0) {
  (Empty, acc) => acc
  (More(x, rest), acc) => continue (rest, x + acc)
}

// REPLACEMENT — for + match (direct translation of loop's multi-value pattern matching)
// Each loop state variable becomes a `for` binding; pattern arms use break/continue
for xs = xs, acc = 0 {
  match xs {
    Empty => break acc
    More(x, rest) => continue rest, x + acc
  }
}

// PREFERRED — for-in with additional loop variables (when iterating a collection)
for x in xs; sum = 0 {
  continue sum + x
} nobreak {
  sum
}

// VALID — C-style for with multiple bindings
for i = 0, acc = 0; i < n; i = i + 1 {
  continue i + 1, acc + xs[i]
} nobreak { acc }

// VALID — simple for-in with mut (imperative style)
let mut acc = 0
for x in xs {
  acc += x
}
```

### When to use which replacement

| `loop` pattern | Replace with |
|---|---|
| Pattern matching on a recursive structure (linked list, tree) | `for` + `match` with state variables |
| Iterating over a collection with accumulator | `for x in xs; acc = 0 { ... }` |
| Index-based iteration with state | C-style `for i = 0, acc = 0; ...` |
| Simple aggregation, no pattern matching needed | `for x in xs` with `let mut` |

## v0.9.2 removed syntax (no longer compiles)

These **hard removals** fail compilation instead of emitting warnings:

```moonbit
// REMOVED — old newtype declaration
type Frontier Array[Int]

// REPLACEMENT — single-field tuple struct
struct Frontier(Array[Int]) derive(Show, Eq)
```

```moonbit
// DEPRECATED — sibling local `fn`s no longer form a mutually recursive group
fn outer() -> Bool {
  fn even(n : Int) -> Bool {
    if n == 0 { true } else { odd(n - 1) }
  }
  fn odd(n : Int) -> Bool {
    if n == 0 { false } else { even(n - 1) }
  }
  even(4)
}

// REPLACEMENT — `letrec name = fn(...) { ... } and name2 = fn(...) { ... }`
fn outer() -> Bool {
  letrec even = fn(n : Int) -> Bool {
    if n == 0 { true } else { odd(n - 1) }
  }
  and odd = fn(n : Int) -> Bool {
    if n == 0 { false } else { even(n - 1) }
  }
  even(4)
}
```

The compiler emits warning [0027] on the old form with the exact migration hint: *"Use `letrec f = fn(a, b) { ... } and g = fn(...) { ... }` instead."* Both forms verified against `moonc` 0.1.20260427.

## v0.9.2 struct constructor (deprecated dual-signature form)

v0.9.2 simplifies struct constructor declarations. Define the constructor directly as one method:

```moonbit
fn Type::Type(params) -> Type { .. }
```

The old form still compiles but emits deprecation warnings.

```moonbit
// PREFERRED — define the constructor directly as one method
fn MyStruct::MyStruct(x : Int, y : Int) -> MyStruct {
  { x, y }
}
```

This is the documented default in `moonbit-base.md` and `moonbit-opaque-types`. If existing code uses the older form and emits a deprecation warning, replace it with the direct constructor method form.

## How this skill is maintained

When a new deprecated pattern is discovered (e.g., CI fails with `deprecated` warning, or user corrects syntax), add it to the table above with the replacement.
