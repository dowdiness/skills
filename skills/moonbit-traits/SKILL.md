---
name: moonbit-traits
description: >
  Reference guide for effective trait usage in MoonBit's Self-based
  trait system (no trait type parameters, no associated types, but
  polymorphic trait methods are supported in v0.10+). Use when
  writing MoonBit traits, designing APIs with traits, or when the user
  asks about trait patterns like endomorphisms, capability traits,
  polymorphic methods, callback-based iteration, trait multiplication,
  newtypes, visitor pattern, or defunctionalized associated types in MoonBit.
---

# Effective trait usage patterns in MoonBit

## Introduction

MoonBit's trait system uses a **Self-type based** design: unlike Haskell's type classes (`class Eq a where ...`), MoonBit traits do not take explicit trait-level type parameters. The implementing type is implicitly available as `Self`. MoonBit traits still have no associated types, but since MoonBit v0.10, individual trait methods may have their own type parameters.

This document explores how to write effective, idiomatic traits under these constraints, organized from the most natural patterns to increasingly creative workarounds.

## Current syntax baseline

In MoonBit v0.10+, trait and impl entries use the `fn` keyword:

```moonbit
trait I {
  fn f(Self) -> Unit
}

impl I for Int with fn f(_) {}
```

Old examples without `fn` may still appear in legacy code, but new guidance should use the `fn` form.

## Understanding the constraints

A MoonBit trait can reference:

- **`Self`** — the implementing type (implicit)
- **Concrete types** — `Int`, `String`, `Bool`, user-defined structs/enums, etc.
- **Method-local type parameters** — declared on an individual method, such as `fn[X] f(Self, X) -> Unit` or `fn[X : Show] write(Self, X) -> Unit`

A MoonBit trait *cannot* reference:

- Type parameters on the trait itself (no `trait Convert[T]`)
- Associated types (no `type Item` inside a trait)
- Implementation-chosen hidden types in method signatures

Method type parameters are **caller-chosen and universal**: an implementation of `fn[X] f(Self, X)` must work for every `X` allowed by the bounds. They do not mean “each implementation chooses one `X`”. If the implementation must fix one type (for example one `State`, one `Event`, and one `Action`), use a generic struct/function record or a defunctionalized wrapper instead of a polymorphic trait method.

## Polymorphic trait methods

Polymorphic trait methods are useful when one method should accept or compute over a type chosen separately at each call site, and the implementation can handle all such types uniformly.

```moonbit
trait Logger {
  fn[X : Show] write_object(Self, X) -> Unit
}

impl Logger for StringBuilder with fn write_object(self, x) {
  self.write_string(x.to_string())
}
```

When implementing a polymorphic trait method, the method's own type parameters usually do not need to be annotated explicitly. If you do annotate them, put method type parameters after `fn`; impl type parameters still go after `impl`:

```moonbit
trait Poly {
  fn[X] f(Self, X) -> Unit
}

impl[A] Poly for Array[A] with fn[X] f(self, x : X) {
  ignore(self)
  ignore(x)
}
```

### Good uses

- Generic sinks/loggers/builders: `fn[X : Show] write(Self, X) -> Unit`
- Folds where the element type is fixed but the accumulator/result is caller-chosen: `fn[R] fold(Self, init : R, f : (R, Int) -> R) -> R`
- Adapters parameterized by a callback, factory, or serializer supplied by the caller

### Bad uses

Do not use method type parameters to fake associated types:

```moonbit
// Usually wrong: this says every implementation can update every S/E/A.
trait AppLike {
  fn[S, E, A] update(Self, S, E) -> (S, Array[A])
}
```

For an embedded app whose implementation fixes `State`, `Event`, and `Action`, prefer a generic record or wrapper:

```moonbit
struct App[S, E, A] {
  init : () -> S
  update : (S, E) -> (S, Array[A])
}
```

## Pattern 1: self-closed algebras (endomorphisms)

The most natural pattern. All inputs and outputs are `Self`.

```moonbit
trait Monoid {
  fn empty() -> Self
  fn combine(Self, Self) -> Self
}

trait Ord {
  fn compare(Self, Self) -> Ordering
}

trait Semigroup {
  fn append(Self, Self) -> Self
}
```

This is ideal for **algebraic structures** where operations close over a single type. Mathematical traits (groups, rings, lattices) and comparison traits fit perfectly.

### Builder pattern variant

Fluent builders are a natural application of `Self -> Self` chains:

```moonbit
trait Builder {
  fn with_name(Self, String) -> Self
  fn with_size(Self, Int) -> Self
  fn build(Self) -> Result
}
```

Each method returns `Self`, enabling chained calls while remaining fully type-safe.

### When to use

- Equality, ordering, hashing
- Algebraic operations (combine, merge, union)
- Fluent/builder APIs
- Any operation that is "closed" over one type

## Pattern 2: fixed-type projections

When a trait needs to produce or consume a value of a type other than `Self`, fix that type to a concrete, domain-appropriate type.

```moonbit
trait Show {
  fn to_string(Self) -> String
}

trait Hash {
  fn hash(Self) -> Int
}

trait ToJson {
  fn to_json(Self) -> JsonValue
}

trait ToBytes {
  fn to_bytes(Self) -> Bytes
}

trait Measure {
  fn size(Self) -> Int
}
```

The key insight: if you would write `trait Show[T] { fn show(Self) -> T }` and then *always* instantiate `T = String`, the type parameter adds no value. A fixed projection is simpler.

### Choosing the right target type

The choice of target type matters. Prefer types that are:

- **Rich enough** to encode all cases: `JsonValue` (a sum type) is far more useful as a serialization target than `String`
- **Standardized** within your codebase: pick one canonical representation for bytes, one for JSON, etc.
- **Composable**: `Bytes` can be concatenated; `Int` (for hashing) can be combined

### When to use

- Serialization / deserialization
- Display / debug output
- Measurement / metrics
- Any "extract a summary" operation

## Pattern 3: capability traits (fine-grained interfaces)

Keep traits small — ideally one or two methods — representing a single capability.

```moonbit
// Good: fine-grained capabilities
trait Readable  { fn read(Self, Bytes) -> Int }
trait Writable  { fn write(Self, Bytes) -> Int }
trait Closable  { fn close(Self) -> Unit }
trait Flushable { fn flush(Self) -> Unit }

// Bad: monolithic interface
trait Stream {
  fn read(Self, Bytes) -> Int
  fn write(Self, Bytes) -> Int
  fn close(Self) -> Unit
  fn flush(Self) -> Unit
  fn seek(Self, Int) -> Int
}
```

Fine-grained traits are essential under this constraint set because:

1. **No trait-level type parameters** means you cannot parameterize the whole trait — so each trait should represent one coherent capability
2. **Method-local polymorphism** is available only when a single method can be implemented uniformly for every admissible method type parameter
3. **Composition via multiple trait bounds** (`T : Readable + Closable`) replaces what would otherwise require generic traits
4. **Implementors** only pay for what they provide

### When to use

- I/O abstractions
- Resource management (open, close, flush)
- Permission / access control modeling
- Any cross-cutting concern

## Pattern 4: polymorphic method capabilities

Use polymorphic methods when the type parameter belongs to the operation, not to the implementor.

```moonbit
trait ObjectWriter {
  fn[X : Show] write_object(Self, X) -> Unit
}

trait IntFoldable {
  fn[R] fold_ints(Self, init : R, f : (R, Int) -> R) -> R
}
```

`ObjectWriter::write_object` works because the writer can render any `X : Show`. `IntFoldable::fold_ints` works because the collection's element type is fixed (`Int`), while the caller chooses the accumulator/result type `R`.

### When to use

- The method type parameter is naturally chosen by the caller at each call
- The implementation can handle every type satisfying the bounds
- The type parameter appears in parameter, callback, accumulator, or adapter position

### When not to use

- The type should be chosen once by each implementation
- The type parameter appears only as an unconstrained return type
- You are trying to model an associated type, iterator item type, app state type, parser output type, etc.

## Pattern 5: callback-based iteration (CPS style)

Without associated types, you still cannot write a generic pull-based `Iterator` trait. The workaround is to push values into callbacks instead of pulling them out.

### Problem

```moonbit
// Cannot write this — `Item` would need to be an associated type.
trait Iterator {
  fn next(Self) -> Item?  // What is `Item`?
}
```

A polymorphic method does not fix this:

```moonbit
// Usually wrong: this says the iterator can produce any X the caller asks for.
trait IteratorLike {
  fn[X] next(Self) -> X?
}
```

### Solution A: domain-specific iterables

Fix the element type to something domain-appropriate:

```moonbit
trait CharSource {
  fn for_each_char(Self, (Char) -> Unit) -> Unit
}

trait EventSource {
  fn for_each_event(Self, (Event) -> Unit) -> Unit
}

trait LineReader {
  fn for_each_line(Self, (String) -> Unit) -> Unit
}
```

You cannot write a single generic `Iterable[T]`, but you can write `CharSource`, `EventSource`, `LineReader` — each serving a specific domain. In practice, this is often sufficient.

### Solution B: polymorphic folds over a fixed element type

Once the element type is concrete, a method-local type parameter can make the accumulator/result type generic:

```moonbit
trait CharSource {
  fn[R] fold_chars(Self, init : R, f : (R, Char) -> R) -> R
}
```

This is often better than exposing mutation through a callback when callers want to compute a result.

### Solution C: universal value type

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
  fn for_each(Self, (Value) -> Unit) -> Unit
}
```

This is effectively a fallback to dynamic typing within a statically-typed shell.

### Solution D: fixed aggregation

If even a polymorphic fold is too much API surface, expose fixed summaries:

```moonbit
trait Summable {
  fn sum(Self) -> Int
}

trait Countable {
  fn count(Self) -> Int
}

trait Reducible {
  fn reduce(Self, (Int, Int) -> Int, Int) -> Int
}
```

This pre-applies the operation, sidestepping the need to abstract over element types entirely.

### When to use

- Streams / event sources / async producers
- Any "collection-like" abstraction
- Logging, metrics, observer patterns

## Pattern 6: trait multiplication (enumerating concrete pairs)

When you need a multi-parameter relationship like `Convert[T]`, decompose it into one trait per target type unless a polymorphic method can implement the operation uniformly.

```moonbit
// Cannot write: trait Convert[T] { fn convert(Self) -> T }

// Instead, enumerate the targets:
trait ToInt    { fn to_int(Self) -> Int }
trait ToFloat  { fn to_float(Self) -> Double }
trait ToString { fn to_string(Self) -> String }
trait ToJson   { fn to_json(Self) -> JsonValue }
```

Polymorphic methods reduce trait multiplication only for operations like “consume any value satisfying this bound”:

```moonbit
trait Sink {
  fn[X : Show] put(Self, X) -> Unit
}
```

They do not replace target-specific conversions, because `fn[X] convert(Self) -> X` would require producing any type the caller requests.

### Managing combinatorial growth

1. **Only define what you need.** In practice, the set of useful conversions is small.
2. **Group by domain.** A serialization module defines `ToJson`, `ToBytes`, `ToXml`. A numeric module defines `ToInt`, `ToFloat`.
3. **Prefer a universal representation.** Route through a common intermediate (like `Value` or `JsonValue`) rather than defining N² direct conversions.
4. **Use polymorphic methods for uniform consumers.** For example, a logger can accept any `X : Show` instead of defining `log_int`, `log_string`, etc.

### When to use

- Type conversions where the target type is fixed by the trait
- Encoding / decoding to specific formats
- Any relationship that would be `trait R[A, B]` in a more expressive system and cannot be made method-polymorphic uniformly

## Pattern 7: newtype wrappers for type-level distinctions

Without trait-level type parameters, you can use newtypes to recover some type-level precision:

```moonbit
struct Meters { value : Double }
struct Seconds { value : Double }
struct MetersPerSecond { value : Double }

trait HasMagnitude {
  fn magnitude(Self) -> Double
}

impl HasMagnitude for Meters with fn magnitude(self) { self.value }
impl HasMagnitude for Seconds with fn magnitude(self) { self.value }
impl HasMagnitude for MetersPerSecond with fn magnitude(self) { self.value }
```

Each newtype can satisfy the same trait differently, and the type system prevents you from mixing `Meters` and `Seconds` accidentally.

### When to use

- Units of measure
- Tagged identifiers (UserId vs. PostId)
- Domain-specific wrappers that share behavior but must not be confused

## Pattern 8: visitor / double dispatch

For operations that need to branch on multiple types without trait-level type parameters:

```moonbit
trait Visitor {
  fn visit_int(Self, Int) -> Unit
  fn visit_str(Self, String) -> Unit
  fn visit_list(Self, Array[Value]) -> Unit
}

trait Visitable {
  fn accept(Self, &Visitor) -> Unit
}
```

Each `visit_*` method takes a concrete type, so no trait-level type parameters are needed. If each visit needs a caller-chosen context or result accumulator, make that individual method polymorphic only when every visitor implementation can handle all admissible context/result types.

### When to use

- AST traversal
- Serialization of heterogeneous data
- Any situation where you need double dispatch

## Pattern 9: defunctionalized associated types

When a trait ideally needs an associated type (a type that varies per implementation), defunctionalize it: each implementation becomes a separate struct that fixes the associated type concretely.

### Problem

```moonbit
// Cannot write — MoonBit has no associated types.
trait Pretty {
  type Ann                        // varies per implementation
  fn to_layout(Self) -> Layout[Ann]
}
```

A polymorphic method is not equivalent:

```moonbit
// Usually wrong: this says every Pretty can produce Layout[A] for every A.
trait PrettyLike {
  fn[A] to_layout(Self) -> Layout[A]
}
```

### Solution

Each "choice" of the associated type becomes a separate struct that fixes the associated type through field types:

```moonbit
// A generic container parameterized over the "associated type"
pub enum Layout[A] {
  Text(String)
  Annotate(A, Layout[A])
  // ...
}

// Each interpretation fixes A concretely via struct field types
struct PrettyLayout  { layout : Layout[SyntaxCategory] }  // A = SyntaxCategory
struct EditorLayout  { layout : Layout[EditorAnn] }       // A = EditorAnn
struct LspLayout     { layout : Layout[LspAnn] }          // A = LspAnn
```

All three can satisfy the same Finally Tagless interpreter trait with one method per AST constructor. See the `moonbit-expression-problem` skill for `TermSym` / `replay` in full. `replay(term)` is a function whose return type is resolved by type ascription at the call site, so it works with any of the three wrapper structs:

```moonbit
let pretty = (replay(term) : PrettyLayout).layout   // Layout[SyntaxCategory]
let editor = (replay(term) : EditorLayout).layout    // Layout[EditorAnn]
let lsp    = (replay(term) : LspLayout).layout       // Layout[LspAnn]
```

### Providing a default via trait

For the most common case, provide a trait with a fixed return type:

```moonbit
pub(open) trait Pretty {
  fn to_layout(Self) -> Layout[SyntaxCategory]   // default defunctionalization
}

// Method syntax for the common case
term.to_layout()

// Explicit TermSym path for richer annotations (see moonbit-expression-problem)
(replay(term) : EditorLayout).layout
```

`Term` itself satisfies `Pretty`, giving the common `SyntaxCategory` annotation a convenient method layer. `EditorLayout` and `LspLayout` do *not* satisfy `Pretty` because their `Layout[A]` return types differ. Callers reach them by choosing a concrete result type such as `EditorLayout`. If you are not using Finally Tagless, the struct-per-annotation idea still applies; replace `replay` with whatever polymorphic construction mechanism fits your codebase.

### Key insight

The associated type becomes a **field type choice** in each struct. Method-local polymorphism does not replace this, because method-local type parameters are caller-chosen while associated types are implementation-chosen. Defunctionalization loses the abstraction of “any annotation type” but gains fully typed variants with no runtime dispatch.

### When to use

- A trait method needs to return `Container[T]` where `T` varies per implementation
- The number of concrete choices for `T` is small and known
- A generic data type (`Layout[A]`, `Array[A]`, `Tree[A]`) is parameterized, but the trait consuming it cannot be
- Combined with Finally Tagless: each TermSym interpretation fixes the container's type parameter differently

## Feasibility check before designing

Before designing a trait abstraction, verify the language can express it:

1. **Write the trait signature first.** If the methods have different arity or return types across implementations (e.g. `process(Self, AudioBuffer)` vs `process(Self, AudioBuffer, AudioBuffer)`), a single trait cannot capture both.
2. **Identify who chooses each type.** If the caller chooses the type on each call and the implementation can handle all admissible choices, use a polymorphic method. If each implementation chooses one hidden type, MoonBit needs a concrete wrapper/function record/defunctionalization instead.
3. **Check what is duplicated.** Often the "duplication" is thin forwarding methods (10 lines each), while the real logic is already shared in a backing struct. Extracting capability traits for the shared interface (e.g. `apply_control`) is worthwhile; forcing a trait over structurally different methods is not.
4. **Prefer capability traits over monolithic unification.** If only some methods can be unified, extract those into a small trait and leave the rest as concrete methods. Partial wins are still wins.

MoonBit traits have no associated types, no default methods, and no trait-level type parameters. They do have method-local type parameters.

## Anti-patterns

### Over-sized traits

```moonbit
// Avoid: too many responsibilities, hard to implement partially
trait DatabaseConnection {
  fn query(Self, String) -> Result
  fn insert(Self, String, Bytes) -> Bool
  fn delete(Self, String, Int) -> Bool
  fn begin_transaction(Self) -> Self
  fn commit(Self) -> Bool
  fn rollback(Self) -> Bool
  fn set_timeout(Self, Int) -> Self
  fn get_stats(Self) -> String
}
```

Split into `Queryable`, `Transactional`, `Configurable`, etc.

### Phantom generality

Don't create a trait that *looks* general but can only have one meaningful implementation. Use a struct directly instead.

### Polymorphic method as fake associated type

Do not add `[T]` to a method just because a concrete implementation has a type named `T`. Method type parameters are universal.

```moonbit
// Wrong for a concrete parser format: it promises every output type.
trait ParserLike {
  fn[T] parse(Self, String) -> T
}
```

Prefer one of:

- A fixed output trait (`fn parse_json(Self, String) -> JsonValue`)
- A generic function/record (`Parser[T]` as a struct, not a trait)
- A callback/factory supplied by the caller
- A defunctionalized wrapper per output family

### Forcing a trait where a function suffices

If the operation does not vary by type, it does not need to be a trait.

## Summary of design heuristics

| Situation | Pattern | Key Idea |
|-----------|---------|----------|
| Operations closed over one type | Self-Closed Algebra | `Self -> Self` |
| Extract a summary/representation | Fixed-Type Projection | `Self -> ConcreteType` |
| Minimal behavioral contracts | Capability Traits | 1-2 methods per trait |
| Caller-chosen generic input/accumulator/adapter | Polymorphic Method | `fn[X : Bound] method(Self, X)`; implementation handles all `X` |
| Iterate over contents | Callbacks / CPS | Push concrete values to `(T) -> Unit` or fold with `fn[R]` |
| Multi-type relationships with target-specific results | Trait Multiplication | One trait per concrete target |
| Type-safe wrappers | Newtypes | Distinct structs, shared traits |
| Branching on multiple types | Visitor | Concrete `visit_*` methods |
| Trait needs associated type | Defunctionalized Associated Types | Each impl struct fixes `Container[A]` concretely |

The guiding principle is to distinguish **caller-chosen** method type parameters from **implementation-chosen** associated-type-like choices. Use polymorphic methods only for the former; embrace concrete types, wrappers, and records for the latter.

## Opaque types (newtype implementation details)

Pattern 7 (Newtypes) gives the concept; this section gives the MoonBit implementation.

### Basic opaque type

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

### Patterns by use case

- **Simple wrapper** (validation): `UserId::UserId(id) -> UserId raise UserIdError`, called as `UserId(id)`
- **Opaque wrapper** (hide complex type): `Version::from_frontier(f) -> Version`
- **Rich API wrapper** exposes semantic methods (`is_insert`, `get_text`) instead of raw access
- **Escape hatch**: `TextDoc::advanced(self) -> @internal.Document` for power users

### When not to use

Use transparent types when internals should be public, no invariants to enforce, or used only internally.

## See also

- **`moonbit-expression-problem`** — for extensible data + operations (Finally Tagless, Two-Layer Architecture, Function Records). Use when the question is "how do I add new variants AND new operations?" rather than "how do I design a trait API?"
