---
name: moonbit-traits
description: >
  Reference guide for effective trait usage in MoonBit's Self-based
  trait system (no type parameters, no associated types). Use when
  writing MoonBit traits, designing APIs with traits, or when the user
  asks about trait patterns like endomorphisms, capability traits,
  callback-based iteration, trait multiplication, newtypes, visitor
  pattern, or defunctionalized associated types in MoonBit.
---

# Effective Trait Usage Patterns in MoonBit

## Introduction

MoonBit's trait system uses a **Self-type based** design: unlike Haskell's type classes (`class Eq a where ...`), MoonBit traits do not take explicit type parameters. The implementing type is implicitly available as `Self`. This design is shared with Rust and Swift, but MoonBit's traits are further constrained by the absence of associated types.

This document explores how to write effective, idiomatic traits under these constraints, organized from the most natural patterns to increasingly creative workarounds.

## Understanding the Constraints

A MoonBit trait can reference:

- **`Self`** — the implementing type (implicit)
- **Concrete types** — `Int`, `String`, `Bool`, user-defined structs/enums, etc.

A MoonBit trait *cannot* reference:

- Type parameters on the trait itself (no `trait Convert[T]`)
- Associated types (no `type Item` inside a trait)

This means every type that appears in a trait method signature, other than `Self`, must be a specific, known type.

## Pattern 1: Self-Closed Algebras (Endomorphisms)

The most natural pattern. All inputs and outputs are `Self`.

```moonbit
trait Monoid {
  empty() -> Self
  combine(Self, Self) -> Self
}

trait Ord {
  compare(Self, Self) -> Ordering
}

trait Semigroup {
  append(Self, Self) -> Self
}
```

This is ideal for **algebraic structures** where operations close over a single type. Mathematical traits (groups, rings, lattices) and comparison traits fit perfectly.

### Builder Pattern Variant

Fluent builders are a natural application of `Self -> Self` chains:

```moonbit
trait Builder {
  with_name(Self, String) -> Self
  with_size(Self, Int) -> Self
  build(Self) -> Result
}
```

Each method returns `Self`, enabling chained calls while remaining fully type-safe.

### When to Use

- Equality, ordering, hashing
- Algebraic operations (combine, merge, union)
- Fluent/builder APIs
- Any operation that is "closed" over one type

## Pattern 2: Fixed-Type Projections

When a trait needs to produce or consume a value of a type other than `Self`, fix that type to a concrete, domain-appropriate type.

```moonbit
trait Show {
  to_string(Self) -> String
}

trait Hash {
  hash(Self) -> Int
}

trait ToJson {
  to_json(Self) -> JsonValue
}

trait ToBytes {
  to_bytes(Self) -> Bytes
}

trait Measure {
  size(Self) -> Int
}
```

The key insight: if you would write `trait Show[T] { show(Self) -> T }` and then *always* instantiate `T = String`, the type parameter adds no value. A fixed projection is simpler.

### Choosing the Right Target Type

The choice of target type matters. Prefer types that are:

- **Rich enough** to encode all cases: `JsonValue` (a sum type) is far more useful as a serialization target than `String`
- **Standardized** within your codebase: pick one canonical representation for bytes, one for JSON, etc.
- **Composable**: `Bytes` can be concatenated; `Int` (for hashing) can be combined

### When to Use

- Serialization / deserialization
- Display / debug output
- Measurement / metrics
- Any "extract a summary" operation

## Pattern 3: Capability Traits (Fine-Grained Interfaces)

Keep traits small — ideally one or two methods — representing a single capability.

```moonbit
// Good: fine-grained capabilities
trait Readable  { read(Self, Bytes) -> Int }
trait Writable  { write(Self, Bytes) -> Int }
trait Closable  { close(Self) -> Unit }
trait Flushable { flush(Self) -> Unit }

// Bad: monolithic interface
trait Stream {
  read(Self, Bytes) -> Int
  write(Self, Bytes) -> Int
  close(Self) -> Unit
  flush(Self) -> Unit
  seek(Self, Int) -> Int
}
```

Fine-grained traits are essential under this constraint set because:

1. **No type parameters** means you cannot parameterize behavior — so each trait must represent one coherent capability
2. **Composition via multiple trait bounds** (`T : Readable + Closable`) replaces what would otherwise require generic traits
3. **Implementors** only pay for what they provide

### When to Use

- I/O abstractions
- Resource management (open, close, flush)
- Permission / access control modeling
- Any cross-cutting concern

## Pattern 4: Callback-Based Iteration (CPS Style)

Without associated types, you cannot write a generic `Iterator` trait. The workaround is to push values into callbacks instead of pulling them out.

### Problem

```moonbit
// Cannot write this — `Item` would need to be an associated type
trait Iterator {
  next(Self) -> Item?  // What is `Item`?
}
```

### Solution A: Domain-Specific Iterables

Fix the element type to something domain-appropriate:

```moonbit
trait CharSource {
  for_each_char(Self, (Char) -> Unit) -> Unit
}

trait EventSource {
  on_event(Self, (Event) -> Unit) -> Unit
}

trait LineReader {
  for_each_line(Self, (String) -> Unit) -> Unit
}
```

You cannot write a single generic `Iterable[T]`, but you can write `CharSource`, `EventSource`, `LineReader` — each serving a specific domain. In practice, this is often sufficient.

### Solution B: Universal Value Type

If you need a single, cross-domain iterable, route through a sum type:

```moonbit
enum Value {
  VInt(Int)
  VStr(String)
  VBool(Bool)
  VList(Array[Value])
  VRecord(Map[String, Value])
}

trait Iterable {
  for_each(Self, (Value) -> Unit) -> Unit
}
```

This is effectively a fallback to dynamic typing within a statically-typed shell.

### Solution C: Fold-Style Aggregation

Instead of yielding individual elements, fold them into a fixed accumulator type:

```moonbit
trait Summable {
  sum(Self) -> Int
}

trait Countable {
  count(Self) -> Int
}

trait Reducible {
  reduce(Self, (Int, Int) -> Int, Int) -> Int
}
```

This pre-applies the operation, sidestepping the need to abstract over element types entirely.

### When to Use

- Streams / event sources / async producers
- Any "collection-like" abstraction
- Logging, metrics, observer patterns

## Pattern 5: Trait Multiplication (Enumerating Concrete Pairs)

When you need a multi-parameter relationship like `Convert[T]`, decompose it into one trait per target type.

```moonbit
// Cannot write: trait Convert[T] { convert(Self) -> T }

// Instead, enumerate the targets:
trait ToInt    { to_int(Self) -> Int }
trait ToFloat  { to_float(Self) -> Double }
trait ToString { to_string(Self) -> String }
trait ToJson   { to_json(Self) -> JsonValue }
```

### Managing Combinatorial Growth

1. **Only define what you need.** In practice, the set of useful conversions is small.
2. **Group by domain.** A serialization module defines `ToJson`, `ToBytes`, `ToXml`. A numeric module defines `ToInt`, `ToFloat`.
3. **Prefer a universal representation.** Route through a common intermediate (like `Value` or `JsonValue`) rather than defining N² direct conversions.

### When to Use

- Type conversions
- Encoding / decoding to specific formats
- Any relationship that would be `trait R[A, B]` in a more expressive system

## Pattern 6: Newtype Wrappers for Type-Level Distinctions

Without type parameters, you can use newtypes to recover some type-level precision:

```moonbit
struct Meters { value: Double }
struct Seconds { value: Double }
struct MetersPerSecond { value: Double }

trait HasMagnitude {
  magnitude(Self) -> Double
}

impl HasMagnitude for Meters with magnitude(self) { self.value }
impl HasMagnitude for Seconds with magnitude(self) { self.value }
impl HasMagnitude for MetersPerSecond with magnitude(self) { self.value }
```

Each newtype can implement the same trait differently, and the type system prevents you from mixing `Meters` and `Seconds` accidentally.

### When to Use

- Units of measure
- Tagged identifiers (UserId vs. PostId)
- Domain-specific wrappers that share behavior but must not be confused

## Pattern 7: Visitor / Double Dispatch

For operations that need to branch on multiple types without type parameters:

```moonbit
trait Visitor {
  visit_int(Self, Int) -> Unit
  visit_str(Self, String) -> Unit
  visit_list(Self, Array[Value]) -> Unit
}

trait Visitable {
  accept(Self, &Visitor) -> Unit
}
```

Each `visit_*` method takes a concrete type, so no type parameters are needed.

### When to Use

- AST traversal
- Serialization of heterogeneous data
- Any situation where you need double dispatch

## Pattern 8: Defunctionalized Associated Types

When a trait ideally needs an associated type (a type that varies per implementation), defunctionalize it: each implementation becomes a separate struct that fixes the associated type concretely.

### Problem

```moonbit
// Cannot write — MoonBit has no associated types
trait Pretty {
  type Ann                        // varies per implementation
  to_layout(Self) -> Layout[Ann]
}
```

### Solution

Each "choice" of the associated type becomes a separate struct implementing a shared trait:

```moonbit
// A generic container parameterized over the "associated type"
pub enum Layout[A] {
  Text(String)
  Annotate(A, Layout[A])
  // ...
}

// Each interpretation fixes A concretely via struct field types
struct PrettyLayout  { layout: Layout[SyntaxCategory] }  // A = SyntaxCategory
struct EditorLayout  { layout: Layout[EditorAnn] }       // A = EditorAnn
struct LspLayout     { layout: Layout[LspAnn] }          // A = LspAnn
```

All three implement the same trait — here called `TermSym`, a Finally Tagless interpreter trait with one method per AST constructor (see the `moonbit-expression-problem` skill for `TermSym` / `replay` in full). `replay(term)` is a function whose return type is resolved by type ascription at the call site, so it works with any of the three wrapper structs:

```moonbit
let pretty = (replay(term) : PrettyLayout).layout   // Layout[SyntaxCategory]
let editor = (replay(term) : EditorLayout).layout    // Layout[EditorAnn]
let lsp    = (replay(term) : LspLayout).layout       // Layout[LspAnn]
```

### Providing a Default via Trait

For the most common case, provide a trait with a fixed return type:

```moonbit
pub(open) trait Pretty {
  to_layout(Self) -> Layout[SyntaxCategory]   // default defunctionalization
}

// Method syntax for the common case
term.to_layout()

// Explicit TermSym path for richer annotations (see moonbit-expression-problem)
(replay(term) : EditorLayout).layout
```

`Pretty` is implemented on `Term` itself — the convenience layer for the default `SyntaxCategory` annotation. `EditorLayout` and `LspLayout` do *not* implement `Pretty` (their `Layout[A]` return types differ); callers reach them via the explicit `replay(term) : StructType` path. If you're not using Finally Tagless, the struct-per-annotation idea still applies; replace `replay` with whatever polymorphic construction mechanism fits your codebase (e.g., overloaded builder functions returning each struct).

### Key Insight

The associated type becomes a **field type choice** in each struct. The trait polymorphism (type ascription on `replay`) is the "dispatch" that associated types would handle automatically. This is the same tradeoff as defunctionalization everywhere: you lose the abstraction (can't write code generic over "any annotation type") but gain concreteness (each variant is fully typed, no runtime dispatch).

### When to Use

- A trait method needs to return `Container[T]` where `T` varies per implementation
- The number of concrete choices for `T` is small and known
- A generic data type (`Layout[A]`, `Array[A]`, `Tree[A]`) is parameterized, but the trait consuming it cannot be
- Combined with Finally Tagless: each TermSym interpretation fixes the container's type parameter differently

## Feasibility Check Before Designing

Before designing a trait abstraction, verify the language can express it:

1. **Write the trait signature first.** If the methods have different arity or return types across implementations (e.g., `process(Self, AudioBuffer)` vs `process(Self, AudioBuffer, AudioBuffer)`), a single trait cannot capture both. MoonBit traits have no associated types, no default methods, and no type parameters.

2. **Check what's actually duplicated.** Often the "duplication" is thin forwarding methods (10 lines each), while the real logic is already shared in a backing struct. Extracting capability traits for the shared interface (e.g., `apply_control`) is worthwhile; forcing a trait over structurally different methods is not.

3. **Prefer capability traits over monolithic unification.** If only some methods can be unified, extract those into a small trait and leave the rest as concrete methods. Partial wins are still wins.

## Anti-Patterns

### Over-Sized Traits

```moonbit
// Avoid: too many responsibilities, hard to implement partially
trait DatabaseConnection {
  query(Self, String) -> Result
  insert(Self, String, Bytes) -> Bool
  delete(Self, String, Int) -> Bool
  begin_transaction(Self) -> Self
  commit(Self) -> Bool
  rollback(Self) -> Bool
  set_timeout(Self, Int) -> Self
  get_stats(Self) -> String
}
```

Split into `Queryable`, `Transactional`, `Configurable`, etc.

### Phantom Generality

Don't create a trait that *looks* general but can only have one meaningful implementation. Use a struct directly instead.

### Forcing Trait Where a Function Suffices

If the operation does not vary by type, it does not need to be a trait.

## Summary of Design Heuristics

| Situation | Pattern | Key Idea |
|-----------|---------|----------|
| Operations closed over one type | Self-Closed Algebra | `Self -> Self` |
| Extract a summary/representation | Fixed-Type Projection | `Self -> ConcreteType` |
| Minimal behavioral contracts | Capability Traits | 1-2 methods per trait |
| "Iterate over contents" | Callbacks / CPS | Push values to `(T) -> Unit` |
| Multi-type relationships | Trait Multiplication | One trait per concrete pair |
| Type-safe wrappers | Newtypes | Distinct structs, shared traits |
| Branching on multiple types | Visitor | Concrete `visit_*` methods |
| Trait needs associated type | Defunctionalized Associated Types | Each impl struct fixes `Container[A]` concretely |

The overarching principle: **embrace the concreteness.** Without type parameters, your traits describe relationships between `Self` and specific, known types. This is not a weakness to work around but a design constraint that pushes toward clear, discoverable, domain-grounded interfaces.

## Opaque Types (Newtype Implementation Details)

Pattern 6 (Newtypes) gives the concept; this section gives the MoonBit implementation.

### Basic Opaque Type

```moonbit
pub(all) struct Pos {
  priv value : Int   // hidden from outside
} derive(Debug, Eq)

suberror PosError {
  NegativePos
} derive(Debug)

pub fn Pos::Pos(value : Int) -> Pos raise PosError {
  guard value >= 0 else { raise NegativePos }
  { value, }
}

pub fn Pos::value(self : Pos) -> Int { self.value }
```

| Component | Purpose |
|-----------|---------|
| `pub(all) struct` | Type visible everywhere |
| `priv` field | Internals hidden from users |
| Custom constructor or named factory | Controlled construction with validation |
| Accessors | Controlled read access |

**Important:** `priv` doesn't work with tuple structs. Use named fields.

### Patterns by Use Case

- **Simple wrapper** (validation): `UserId::UserId(id) -> UserId raise UserIdError`, called as `UserId(id)` or `try? UserId(id)`
- **Opaque wrapper** (hide complex type): `Version::from_frontier(f) -> Version`
- **Rich API wrapper**: expose semantic methods (`is_insert`, `get_text`), not raw access
- **Escape hatch**: `TextDoc::advanced(self) -> @internal.Document` for power users

### When NOT to Use

Use transparent types when internals should be public, no invariants to enforce, or used only internally.

## See Also

- **`moonbit-expression-problem`** — for extensible data + operations (Finally Tagless, Two-Layer Architecture, Function Records). Use when the question is "how do I add new variants AND new operations?" rather than "how do I design a trait API?"
