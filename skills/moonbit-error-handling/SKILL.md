---
name: moonbit-error-handling
description: >
  Error handling conventions for MoonBit projects. Use when designing
  error types, choosing between abort/fail/raise, writing catch blocks,
  defining FFI boundaries, or reviewing error handling patterns. Triggers
  on: error handling, abort, fail, raise, catch, Result, error types,
  fallible functions, boundary safety, error recovery.
---

# MoonBit Error Handling Conventions

Reference for consistent, safe error handling across MoonBit projects. Grounded in MoonBit's error primitives and designed for long-running WASM/browser applications where crashes are especially costly.

**MoonBit version note:** Based on MoonBit's current error handling model (2025). `suberror A B` bare syntax is deprecated; use `suberror A { A(B) }`. Verify against [MoonBit error handling docs](https://docs.moonbitlang.com/en/latest/language/error-handling.html) if syntax has changed.

## Quick Reference

| Primitive | Catchable? | Includes location? | Use for |
|-----------|-----------|-------------------|---------|
| `abort("msg")` | No | No | Poisoned state, no safe recovery possible |
| `fail("msg")` | Yes | Yes (auto) | Defect detected before mutation or with rollback |
| `raise MyError::V(...)` | Yes | No (manual) | Expected failure callers handle programmatically |
| `try { ... } catch { ... }` | — | — | Catch and handle at boundaries |
| `try?` | — | — | Convert to `Result[T, E]` (preserves concrete `E`) |
| `raise?` | — | — | Error polymorphism for higher-order functions |
| `noraise` | — | — | Explicitly infallible (but does NOT prevent `abort`) |

## Decision Framework

Error handling has two independent dimensions: **control flow** (how the error propagates) and **fault class** (what caused the error).

### Control Flow

```
abort ———— fail ———— raise ConcreteError ———— return (T, Diagnostics)
uncatchable  catchable   catchable+typed          always succeeds
             +location   +matchable               +warnings
```

### Fault Class

| Fault class | Description | Default mechanism |
|-------------|-------------|-------------------|
| **Defect** | Logic bug: unreachable branch, impossible state. Data is consistent but code shouldn't be here. | `fail("msg")` |
| **Expected** | Input validation, I/O, parsing, business logic | `raise ConcreteError` |
| **Corruption** | Data integrity loss: broken invariants, poisoned state, partial mutation without rollback | `abort("msg")` |

### The Decision Tree

```
Is the data structure / state already corrupt?
  (e.g., B-tree node with no children, invalid cursor, broken invariant)
  YES ──► abort("msg")  [pre-existing corruption — can't trust anything]

Has this operation already mutated shared state without rollback?
  (e.g., partially rebalanced tree, half-applied batch)
  YES ──► abort("msg")  [mutation without rollback = poison]

Is this a programmer bug (unreachable branch, impossible state)?
  YES ──► fail("msg")   [no corruption, safe to unwind to boundary]

Is the operation recoverable with degraded output?
  YES ──► return (T, Array[Diagnostic])

Otherwise:
  ──► raise ConcreteError::Variant(...)
```

**Key distinction:** A guard that checks structural integrity (e.g., "node must have children") detects *pre-existing corruption*, not a precondition on caller input. Even if the guard fires before *this function* mutates anything, the data structure is already in a corrupt state. That's the corruption fault class, not defect.

**No safe recovery = abort.** Even when the fault class is defect (not corruption), if catching the error and continuing would cause *subsequent operations* to produce silently wrong results, use `abort`. The question isn't just "is the data corrupt now?" but also "can the caller safely continue after this?" Example: if a parser's `start_at` fails and the parser continues, the next `finish_node` closes the wrong ancestor — silently corrupting the tree. That's worse than crashing. When recovery corrupts, abort is correct even for defects.

**This rule takes precedence over the FFI-reachability prohibition** (see FFI Safety below and the checklist's "unless corruption-risk" clause). The FFI-reachability rule forbids `abort` for ordinary defects where catching and continuing is safe; it does not forbid `abort` for the no-safe-recovery case. "corruption-risk" in the checklist means **either** pre-existing corruption **or** "recovery would corrupt subsequent operations" — both qualify. A WASM module crash is the correct outcome when the alternative is silent mis-structuring that the host cannot detect.

### When to Use Each

**`abort("msg")`** — Almost never in application code.

```moonbit
// Corrupted data structure — continuing would silently produce wrong results
fn validate_invariant(self : BTree[T]) -> Unit {
  guard self.keys.length() + 1 == self.children.length() else {
    abort("BTree invariant violated: key/child count mismatch")
  }
}
```

**`fail("msg")`** — Defect in logic, not in data. The data structure is consistent, but the code reached a path that should be impossible.

```moonbit
// Unreachable match branch — if hit, it's a bug, but no state is corrupted
fn node_color(kind : NodeKind) -> String {
  match kind {
    Identifier => "#82aaff"
    Keyword => "#c792ea"
    Number => "#f78c6c"
    // If we add a new NodeKind variant and forget this match, fail() will
    // report the source location and unwind to the nearest boundary
    _ => fail("unhandled NodeKind in node_color")
  }
}
```

**`raise ConcreteError`** — Expected failures with recovery paths.

```moonbit
type! ParseError {
  InvalidSyntax(message~ : String, span~ : Span)
  UnexpectedEof(expected~ : String)
}

fn parse_expression(tokens : TokenStream) -> Expr raise ParseError {
  guard tokens.peek().is_some() else {
    raise ParseError::UnexpectedEof(expected="expression")
  }
  // ...
}
```

**`return (T, Diagnostics)`** — Degraded success with warnings.

```moonbit
// Parser error recovery: always produces a tree, reports problems separately
fn parse_cst(source : String) -> (CstNode, Array[Diagnostic]) raise LexError {
  // Fatal lexer errors still raise — the lexer can't recover from these.
  // But parse errors produce Error nodes in the tree + diagnostics.
  // ...
}
```

The returned `T` is a **complete, usable value** — for tree-shaped data, that means Error nodes are embedded at fault sites so downstream traversal continues working; for flat data (e.g., a JSON `Value`), that means a reasonable fallback (e.g., "last value wins" on duplicate keys). It is not a partial prefix that stops at the first problem — callers should be able to ignore the diagnostics and still process the value. If no such fallback exists for a given failure mode, that mode belongs in the `raise` channel, not in diagnostics.

## Error Type Design

### Granularity: Group by Catch Site

Error type granularity is determined by **who catches the error and what decisions they make**, not by package structure.

- **Errors that callers typically catch together** should share a type
- **Errors that callers handle independently** should have separate types

This matters because of a MoonBit-specific constraint: when a `try` block raises multiple error types, the compiler widens to `Error` and exhaustiveness checking is lost. Separate types harm callers who handle them in the same `try` block. Conversely, one giant enum forces callers to write match arms for variants that can never occur in their context.

**How to decide:** Look at the boundary where errors are caught. If the catch site distinguishes between failure modes, those modes need separate types. If it handles them uniformly, they can share a type.

```moonbit
// Good: editor's FFI boundary catches serialization, editing, and sync
// errors at different points with different recovery strategies
type! EphemeralError { /* serialization — retry with fresh state */ }
type! TreeEditError { /* structural edit — show error, discard operation */ }
type! ProtocolError { /* sync — disconnect and reconnect */ }

// Bad: one catch-all — callers must match variants that can't occur
type! EditorError { Ephemeral(...), TreeEdit(...), Protocol(...) }

// Bad: one per function — callers in a try block lose exhaustiveness
type! InsertError { ... }
type! DeleteError { ... }
type! MoveError { ... }
```

**When a package has no expected failures** (all errors are defects or corruption), it needs no error types at all. Use `fail` for defects and `abort` for corruption. Don't create error types for bugs — they're not part of the API contract.

### Variant Design: Semantic, With Context

Name variants by what went wrong semantically, not by which dependency failed. Include enough context for the caller to act on.

```moonbit
// Good: semantic variants with context
type! TextError {
  InvalidPosition(pos~ : Int, len~ : Int)
  SyncFailed(detail~ : String)
  VersionNotFound
}

// Bad: mechanical wrappers that leak dependencies
type! TextError {
  FromOplog(OpLogError)
  FromFugue(FugueError)
}
```

**Exception:** When the dependency IS the semantic contract (thin facades, re-export packages), direct propagation is correct. See Boundary Rules below.

**Pitfall: same syntax, different semantics.** When multiple code paths share the same syntactic pattern (e.g., `stack.last() → None`), don't assign the same variant to all of them. Trace *why* the condition fires in each context. Example: `stack.last() → None` after a FinishNode means an unbalanced FinishNode consumed the root frame; the same pattern after a Token means the token has no parent because prior FinishNodes emptied the stack. These are different error variants (`UnbalancedFinish` vs `OrphanedEvent`) despite identical syntax.

### Error Hierarchies (`suberror`)

Use `suberror` only when one subsystem's errors are a genuine subset of another's. Do not create hierarchies for organizational purposes.

```moonbit
// Good: CausalGraphError is genuinely a subset of OpLogError
type! CausalGraphError { ... }
suberror OpLogError { CausalGraph(CausalGraphError) }

// Bad: hierarchy for organization
suberror AppError { Editor(EditorError), Parser(ParserError) }
```

### `Failure` vs Custom Error Types

`Failure` (via `fail()`) is for defect detection only. If the condition can be triggered by:
- Caller input
- Configuration
- Network data
- Disk contents
- Version skew

...then it is an **expected failure**, not a defect. Use `raise ConcreteError`.

## Function Signatures

| Situation | Signature | Rationale |
|-----------|-----------|-----------|
| Public library API | `fn foo() -> T raise MyError` | Callers match on variants. Exhaustiveness checked. |
| Thin facade / re-export | `fn foo() -> T raise DependencyError` | Dependency is the semantic contract. Direct propagation. |
| Internal orchestration | `fn foo() -> T raise` | Caller will only log or propagate. Error taxonomy is not part of the contract. Use sparingly — once widened to `Error`, matchability is lost. |
| Higher-order forwarding | `fn map(f : (A) -> B raise?) -> Array[B] raise?` | Preserves caller's error type via polymorphism. |
| Definitely infallible | `fn foo() -> T noraise` | Explicit guarantee. **Caveat:** `noraise` does NOT prevent `abort`. A `noraise` function can still crash. |
| Defect guard | `fail("reason")` | Source location included. Only for impossible states. |

## Boundary Rules

### Where to Catch

Errors should propagate upward until they reach a **quarantine boundary** — a point where the application can discard suspect state and restore trust.

| Boundary type | Catch strategy | Post-catch action |
|---------------|---------------|-------------------|
| **FFI entrypoint** (MoonBit to JS) | Catch all: `catch { e => ... }` | Convert to structured error envelope (not bare strings). Log. Return error to host. |
| **Event dispatch** (user action) | Catch all | Log, show error to user, discard the failed operation. |
| **Network message handler** | Catch all | Log, reject the message, continue processing others. |
| **Inside library/core** | Catch **specific types only** | Handle the expected case. Rethrow unknown errors. |

### Catch-Block Discipline

**Inside core/library code** — explicit cases plus rethrow:

```moonbit
// Good: handle known cases, rethrow unknown
fn process(data : Data) -> Result raise ProcessError {
  try {
    step_one(data)  // may raise StepOneError
    step_two(data)  // may raise StepTwoError
  } catch {
    StepOneError::Retry(info) => handle_retry(info)
    e => raise e  // rethrow everything else, including Failure
  }
}
```

**At boundaries** — catch all, but treat `Failure` as defect:

```moonbit
// Good: FFI boundary catches everything, distinguishes defects
pub fn ffi_handle_action(handle : Int, action_json : String) -> String {
  try {
    let editor = get_editor(handle)
    editor.apply_action(action_json)
    "ok"
  } catch {
    TreeEditError(e) => to_error_json("edit_error", e.to_string())
    ProtocolError(e) => to_error_json("protocol_error", e.to_string())
    Failure(msg) => {
      log_defect(msg)  // This is a bug — report it
      to_error_json("internal_error", msg)
    }
    e => {
      log_defect(e.to_string())
      to_error_json("unknown_error", e.to_string())
    }
  }
}
```

**Banned patterns** (except at documented boundary adapters):

```moonbit
// BANNED: silently swallows all errors including defects
catch { _ => () }

// BANNED: hides failures behind a default value
catch { _ => default_value }

// ALLOWED (at boundaries only, with logging):
catch {
  KnownError(e) => handle(e)
  e => { log_defect(e.to_string()); fallback }
}
```

### FFI Safety: `abort` Bypasses Catch

`abort` is outside the raise/catch channel. An outer `catch` block does NOT protect against `abort`. This means:

**Every code path reachable from an FFI export must be audited for `abort` calls.** If an FFI-exported function can reach an `abort`, the WASM module will crash regardless of any catch block.

When reviewing FFI boundary code, trace all reachable functions and verify they use `fail` (catchable) instead of `abort` for non-corruption failures.

**Exception — the "no safe recovery" carve-out.** The audit's goal is to eliminate `abort` from FFI-reachable paths *when catching and continuing is safe*. It is not to eliminate `abort` universally. When continuing after a caught error would corrupt subsequent operations (see "No safe recovery = abort" in Decision Framework above), the `abort` is the correct outcome and the audit result is "intentionally retained." Document the rationale inline. Classic example: a CST/AST builder with stack-shaped state — an unbalanced `finish_node` means future calls will close unintended ancestors, so crashing the WASM module is preferable to silent tree corruption.

## Mutation Safety

Any function that mutates shared state and can `raise` must satisfy one of:

1. **Atomic** — mutation is all-or-nothing (e.g., swap a single reference)
2. **Rollback-safe** — mutations are undone on error (e.g., transactional batch)
3. **Documented partial effects** — the function's doc comment states what state may be left modified on error

If a function mutates shared state, raises an error mid-mutation, and a boundary catches and continues — the state may be inconsistent. This is the primary reason `fail` for defects is only safe when detected **before** observable mutation or inside a rollback scope.

```moonbit
// Good: atomic — either the whole batch applies or none of it does
fn apply_batch(ops : Array[Op]) -> Unit raise BatchError {
  let snapshot = self.state.snapshot()
  for op in ops {
    self.apply_one(op) catch {
      e => {
        self.state.restore(snapshot)
        raise BatchError::PartialFailure(applied=i, cause=e.to_string())
      }
    }
  }
}

// Dangerous: mutates state, then fails, leaving partial mutation
fn dangerous_update(self : Editor) -> Unit {
  self.tree.insert(node)      // mutation happens
  let result = validate(node)  // this might fail()
  self.index.update(node)      // never reached if validate fails
  // tree is mutated but index is stale — inconsistent state
}
```

## Diagnostic Pattern

For operations that succeed with warnings (parser error recovery, linting, deprecation notices), return a structured diagnostic alongside the result.

### Minimum Diagnostic Structure

`Array[String]` is insufficient except for prototyping. A proper diagnostic includes:

```moonbit
pub(all) enum Severity {
  Error
  Warning
  Info
}

pub(all) struct Diagnostic {
  severity : Severity
  message : String
  span : (Int, Int)  // start, end byte offsets
}
```

The specific type is project-defined, but the convention requires at least **severity** and **message**. Span/location is strongly recommended.

### Diagnostics vs Errors

These are orthogonal concerns:

```moonbit
// A function can BOTH raise fatal errors AND return diagnostics for non-fatal ones
fn parse_cst(source : String) -> (CstNode, Array[Diagnostic]) raise LexError {
  // LexError = fatal, can't continue (Layer: expected failure, raise)
  // Diagnostic = non-fatal, parser recovered (Layer: degraded success)
}
```

## Testing Error Behavior

### Testing `raise` (expected failures)

Use `try?` to convert to Result, then assert:

```moonbit
test "div by zero raises DivError" {
  let result : Result[Int, _] = try? { div(10, 0) }
  inspect(result, content="Err(DivByZero)")
}
```

### Testing `fail` (defects)

Use panic tests (test name starts with `"panic "`):

```moonbit
test "panic unreachable branch triggers fail" {
  // The test runner expects this to abort/fail
  node_color(UnknownKind)
}
```

### Testing diagnostics

Assert on the returned diagnostic array:

```moonbit
test "malformed input produces diagnostics" {
  let (tree, diagnostics) = parse_cst("{\"a\": }")
  assert_true(diagnostics.length() > 0)
  assert_true(tree.is_valid())  // tree is still usable
}
```

## Anti-Patterns

| Pattern | Problem | Fix |
|---------|---------|-----|
| `catch { _ => abort("...") }` | Converts catchable error to uncatchable crash | Propagate with `raise` or use `fail` |
| `catch { _ => () }` in library code | Silently swallows defects and expected errors | Handle specific types, rethrow unknown |
| `fail("invalid input: ...")` for user input | `fail` is for defects, not validation | `raise ConcreteError::InvalidInput(...)` |
| `raise` in untyped `Error` for public APIs | Callers lose exhaustiveness checking | Use concrete `raise MyError` |
| `abort` in code reachable from FFI | Crashes WASM module, bypasses catch | Audit and convert to `fail` or `raise` |
| `noraise` on function that calls `abort` | Misleading — `noraise` only covers `raise`, not `abort` | Document abort paths or eliminate them |
| Giant umbrella error enum | One type with 20 variants spanning unrelated catch sites | Split by catch-site — errors caught together share a type |

## Boundary Wrapping vs Direct Propagation

When package A calls package B which raises `BError`:

| Relationship | Strategy | Example |
|-------------|----------|---------|
| A is a thin facade over B | Propagate `BError` directly | `parse_to_proj_node` propagating `LexError` |
| B is part of A's semantic contract | Propagate directly | `SyncEditor` exposing `TextError` |
| B is an implementation detail | Wrap with semantic variants | `EditorError::SyncFailed(detail~)` not `EditorError::FromEgw(TextError)` |
| B is replaceable | Wrap — A's API must be independent of B | Translate to A's own error vocabulary |

## Audit Process

The process below is written for auditing existing `abort` calls, but the same four steps apply when **designing new** fallible APIs — substitute "for each new `raise` / `fail` / `abort` site" for "for each abort site" in step 4, and the other steps carry over unchanged.

When auditing `abort` calls for conversion to `fail`/`raise`:

**1. Read the package's design docs first.** Check `docs/design.md`, `docs/api/`, README. The package may have its own error handling philosophy that prescribes the answer. Don't classify aborts using only the decision tree — the design docs provide context the tree can't.

**2. Find ALL callers of functions whose signatures will change.** Use `moon ide find-references` or grep the entire module — not just the file you expect callers in. A missed caller means an unhandled error path that still crashes. Pay special attention to: benchmarks, test helpers, and alternate code paths (e.g., block reparse vs normal parse).

**3. Trace error variants through concrete scenarios.** After writing the error type and mapping table, pick one concrete input per variant and trace execution step by step. Verify each variant name matches the actual state when it fires. Same syntactic pattern (e.g., `stack.last() → None`) can mean different things in different code paths — don't map mechanically.

**4. Ask "what happens if the caller continues?"** For each abort site, before converting: if this error is caught and the program continues, do subsequent operations produce silently wrong results? If yes, keep the abort.

## Checklist

When reviewing error handling in MoonBit code:

- [ ] No `abort` in code reachable from FFI exports (unless corruption-risk)
- [ ] `fail` used only for defect detection, never for input validation
- [ ] No `catch { _ => () }` or `catch { _ => default }` in library code
- [ ] Catch blocks in library code rethrow unknown errors (`e => raise e`)
- [ ] Public APIs use concrete error types (`raise MyError`), not bare `raise`
- [ ] Functions that mutate shared state and can raise are atomic or rollback-safe
- [ ] Diagnostics use structured types, not `Array[String]` (except prototyping)
- [ ] `noraise` functions audited for `abort` paths
- [ ] Error variants are semantic (describe what went wrong) with context fields
- [ ] Error variants traced through concrete scenarios (same syntax ≠ same variant)
- [ ] Abort sites checked for "no safe recovery" (continuing produces silent corruption)
