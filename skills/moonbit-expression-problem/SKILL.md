---
name: moonbit-expression-problem
description: >
  Guide to solving the Expression Problem in MoonBit using Finally
  Tagless encoding, two-layer architecture (tagless + concrete AST),
  polymorphic trait methods, and related patterns. Use when designing
  extensible data types, adding new variants or operations to existing
  code, working with Finally Tagless, Object Algebras, open recursion,
  or discussing extensibility trade-offs in MoonBit.
---

# Solving the expression problem in MoonBit

## The expression problem

The Expression Problem, coined by Philip Wadler in 1998, asks: can you add both new data variants *and* new operations to a datatype, without modifying existing code, while maintaining type safety and separate compilation?

It defines two axes of extension:

- **Data axis**: Add a new variant (e.g., add `Mul` to an expression language that has `Lit` and `Add`)
- **Operation axis**: Add a new operation (e.g., add `pretty_print` to a language that already supports `eval`)

Most languages make one axis easy and the other hard:

| Approach | Data axis | Operation axis |
|----------|-----------|----------------|
| Algebraic data types + pattern matching | Hard (must edit enum) | Easy (add a new function) |
| OOP classes + virtual methods | Easy (add a new subclass) | Hard (must edit base class) |

MoonBit, with its Self-based traits (no trait-level type parameters, no associated types, but method-local polymorphic trait methods in v0.10+), has a specific set of tools available. This document surveys the solution space, from the most effective approach to partial workarounds.

## Current trait syntax and polymorphic methods

MoonBit v0.10 requires the `fn` keyword on trait methods and impl entries:

```moonbit
trait I {
  fn f(Self) -> Unit
}

impl I for Int with fn f(_) {}
```

Trait methods may now have their own type parameters:

```moonbit
trait ObjectWriter {
  fn[X : Show] write_object(Self, X) -> Unit
}

impl ObjectWriter for StringBuilder with fn write_object(self, x) {
  self.write_string(x.to_string())
}
```

This is **method-local universal polymorphism**: the caller chooses `X` on each call, and the implementation must work for every `X` satisfying the bounds. If you write the method type parameters explicitly in an impl, they go after `fn`; impl type parameters still go after `impl`:

```moonbit
trait Poly {
  fn[X] f(Self, X) -> Unit
}

impl[A] Poly for Array[A] with fn[X] f(self, x : X) {
  ignore(self)
  ignore(x)
}
```

Polymorphic trait methods are useful inside expression-problem designs when the generic type is chosen by the **caller** and handled uniformly by every implementation. They do **not** provide trait-level type parameters, associated types, existential expression values, or implementation-chosen output types. In particular, `fn[A] parse(Self, String) -> A` would promise that one parser can produce any type the caller asks for; it is not a substitute for `type Output`.

## Solution 1: Finally Tagless (primary recommendation)

Finally Tagless encoding is the most effective solution to the Expression Problem under MoonBit's constraints. It works by representing syntax as **trait method calls** rather than data constructors.

### Naming: the `*Sym` convention

Traits in this pattern are named with the `Sym` suffix — `ExprSym`, `TermSym`, `ArithSym`. This comes from **Symantics**, a portmanteau of *syntax* and *semantics* coined by Kiselyov in the original Finally Tagless paper. Each trait method is a syntactic constructor whose meaning (semantics) is supplied by whichever type `Self` is bound to. The name signals this dual role.

### Basic setup

```moonbit
trait ExprSym {
  fn lit(Int) -> Self
  fn add(Self, Self) -> Self
  fn neg(Self) -> Self
}
```

An "expression" is not a data structure; it is a polymorphic function that works for any type implementing `ExprSym`. Concrete types serve as *interpretations* (operations):

```moonbit
// Interpretation 1: Evaluation
struct Eval { value: Int }

impl ExprSym for Eval with fn lit(n) { { value: n } }
impl ExprSym for Eval with fn add(a, b) { { value: a.value + b.value } }
impl ExprSym for Eval with fn neg(a) { { value: -a.value } }

// Interpretation 2: Pretty-printing
struct Show { repr: String }

impl ExprSym for Show with fn lit(n) { { repr: n.to_string() } }
impl ExprSym for Show with fn add(a, b) {
  { repr: "(\{a.repr} + \{b.repr})" }
}
impl ExprSym for Show with fn neg(a) {
  { repr: "(-\{a.repr})" }
}
```

Expressions are written as generic functions:

```moonbit
fn[T : ExprSym] example1() -> T {
  T::add(T::lit(1), T::neg(T::lit(2)))
}
```

### Extending the data axis

To add a new syntactic form (e.g., multiplication), define a **new trait** — no existing code changes:

```moonbit
trait MulSym {
  fn mul(Self, Self) -> Self
}

impl MulSym for Eval with fn mul(a, b) { { value: a.value * b.value } }
impl MulSym for Show with fn mul(a, b) {
  { repr: "(\{a.repr} * \{b.repr})" }
}
```

New expressions can use both traits:

```moonbit
fn[T : ExprSym + MulSym] example2() -> T {
  T::mul(T::add(T::lit(2), T::lit(3)), T::lit(4))
}
```

### Extending the operation axis

To add a new operation (e.g., computing expression depth), define a **new struct** and provide impls for all relevant traits. Existing code stays unchanged:

```moonbit
struct Depth { depth: Int }

impl ExprSym for Depth with fn lit(_n) { { depth: 0 } }
impl ExprSym for Depth with fn add(a, b) {
  { depth: 1 + @math.maximum(a.depth, b.depth) }
}
impl ExprSym for Depth with fn neg(a) {
  { depth: 1 + a.depth }
}

impl MulSym for Depth with fn mul(a, b) {
  { depth: 1 + @math.maximum(a.depth, b.depth) }
}
```

### Scorecard

| Property | Status | Notes |
|----------|--------|-------|
| New variants without modifying existing code | ✓ | Add a new trait |
| New operations without modifying existing code | ✓ | Add a new struct + impls |
| Type safety | ✓ | Fully static |
| Separate compilation | ✓ | Each extension is independent |
| Pattern matching on structure | ✗ | Structure is lost after construction |
| Simultaneous multiple interpretations | Partial | Requires boilerplate (see below) |
| Dynamic expression construction | ✗ | Expressions are parametric functions |

### Combining multiple interpretations

To evaluate *and* pretty-print simultaneously, you need a product type:

```moonbit
struct EvalAndShow {
  eval: Eval
  show: Show
}

impl ExprSym for EvalAndShow with fn lit(n) {
  { eval: ExprSym::lit(n), show: ExprSym::lit(n) }
}
impl ExprSym for EvalAndShow with fn add(a, b) {
  {
    eval: ExprSym::add(a.eval, b.eval),
    show: ExprSym::add(a.show, b.show),
  }
}
impl ExprSym for EvalAndShow with fn neg(a) {
  {
    eval: ExprSym::neg(a.eval),
    show: ExprSym::neg(a.show),
  }
}
```

This is repetitive but mechanical. With macro support or code generation, it can be automated.

### Limitations in detail

**No structural observation.** The following cannot be written:

```moonbit
// IMPOSSIBLE: there is no AST node to match on
fn[T : ExprSym] optimize(e : T) -> T {
  match e {
    Add(Lit(0), x) => x    // No match — Self is opaque
    _ => e
  }
}
```

**No first-class expression values.** An expression like `example1` is a function `[T : ExprSym]() -> T`, rather than a storable value. You cannot place it in a data structure or pass it to a non-generic function.

### Polymorphic trait methods in tagless DSLs

Method-local type parameters can make a tagless DSL more compact when a syntactic constructor is genuinely generic and all interpretations can handle it uniformly. For example, a pretty-printing-only DSL can accept any displayable literal:

```moonbit
trait PrettyLiteralSym {
  fn[X : Show] lit(X) -> Self
}

struct Pretty { repr : String }

impl PrettyLiteralSym for Pretty with fn lit(x) {
  { repr: x.to_string() }
}
```

But the same constructor is not appropriate for an evaluator that only knows how to evaluate integers. If an interpretation needs type-specific semantics, keep separate concrete constructors/traits (`int_lit`, `string_lit`, etc.) or introduce a closed sum type for literal values.

Polymorphic trait methods also help with caller-chosen continuations or accumulators:

```moonbit
trait ExprConsumer {
  fn[R] consume(Self, on_lit : (Int) -> R, on_add : (R, R) -> R) -> R
}
```

The important rule is: method type parameters are **caller-chosen**. They do not recover structure, produce first-class expression values, or model implementation-chosen associated types.

## Solution 1b: extensible enums (`extenum`, v0.9.2)

MoonBit v0.9.2 introduces the `extenum` keyword, which **partially** addresses the data axis directly: an `extenum` declared in package `A` can have new variants added by another package `B` via `+=`, without editing `A`.

```moonbit
// In package @core
pub extenum Expr {
  Lit(Int)
  Add(Expr, Expr)
}

// In package @plugin — adds Mul without editing @core.
// Extension uses the `extenum` keyword on both sides of `+=`.
extenum @core.Expr += {
  Mul(@core.Expr, @core.Expr)
}
```

Pattern matching on an `extenum` requires a wildcard arm — the compiler cannot prove exhaustiveness when downstream packages may add more variants, and rejects the match as a partial-match error otherwise. Constructors defined in a foreign package are referenced as `@pkg.Constructor`:

```moonbit
fn eval(e : @core.Expr) -> Int {
  match e {
    @core.Lit(n) => n
    @core.Add(a, b) => eval(a) + eval(b)
    @plugin.Mul(a, b) => eval(a) * eval(b)
    _ => abort("unknown Expr variant")   // required fallback
  }
}
```

When matching an extenum defined in the *current* package, constructor names can be used unqualified — but the wildcard arm is still required.

### Scorecard

| Property | Status | Notes |
|----------|--------|-------|
| New variants by independent packages | ✓ | `@core.Expr += { ... }` from any downstream package |
| New operations | Partial | Each operation must include a wildcard arm; new variants from a plugin will hit the wildcard until each operation is updated |
| Pattern matching on structure | ✓ | Full structural access, with the catch above |
| Type safety | Partial | Exhaustiveness is enforced *modulo* the mandatory wildcard — silent fallthrough is possible if a consumer forgets to handle a newly-added variant |
| Separate compilation | ✓ | Plugin packages compile independently |

### When `extenum` fits

- The set of "core" variants is known and stable, but **plugins genuinely need to add variants** in their own packages.
- Operations are written in well-known sites that can be updated when new variants appear, OR they have sensible fallback behavior (`abort`, "skip unknown nodes", default rendering, etc.).
- Pattern-matching ergonomics (`match`, destructuring) matter more than compile-time exhaustiveness.

### When `extenum` does not fit

- You need **statically-verified exhaustiveness** across all current and future variants. The mandatory wildcard arm defeats this because an unhandled variant becomes a runtime concern rather than a type error.
- You need **operation-axis extensibility without coordination**. Each new operation function on `@core.Expr` must still hand-roll arms for every constructor; this is the same enum-axis problem as Solution 2.
- You want to use type ascription / parametric polymorphism to select among many "interpretations" of the same expression — that is Finally Tagless territory.

### Comparison

| Need | `extenum` | Finally Tagless | Two-Layer |
|------|-----------|-----------------|-----------|
| Cross-package variant extension | ✓ | ✓ (new trait) | ✗ (enum is closed in core) |
| Cross-package operation extension | ✗ (must touch each operation) | ✓ (new struct) | ✓ (new struct, on tagless side) |
| Compile-time exhaustiveness | Partial (wildcard required) | N/A (no matching) | ✓ (within owning package) |
| Pattern matching / structural passes | ✓ | ✗ | ✓ (via concrete layer) |

`extenum` is the **closest MoonBit comes to row-polymorphic / open sum types**, but pays for that with mandatory wildcard fallbacks. It complements Finally Tagless rather than replacing it: use `extenum` when you specifically need pattern-matching on plugin-defined variants; use Finally Tagless when you need both axes open without losing exhaustiveness.

## Solution 2: enum + trait (baseline, one-axis only)

For reference, the conventional approach:

```moonbit
enum Expr {
  Lit(Int)
  Add(Expr, Expr)
}

fn eval(e: Expr) -> Int {
  match e {
    Lit(n) => n
    Add(a, b) => eval(a) + eval(b)
  }
}
```

**Operation axis:** Define a new function with a match.
**Data axis:** Adding a variant requires editing `Expr`.

This is not a solution to the Expression Problem, but it is the right choice when:

- The set of variants is closed (known at design time, unlikely to change)
- Pattern matching / structural observation is essential
- Performance of tree traversal matters

## Solution 3: two-layer architecture (recommended hybrid)

The most practical architecture combines Finally Tagless for extensibility with a concrete AST for structural operations.

### Layer 1: abstract (Finally Tagless)

```moonbit
trait ExprSym {
  fn lit(Int) -> Self
  fn add(Self, Self) -> Self
}

trait MulSym {
  fn mul(Self, Self) -> Self
}
```

### Layer 2: concrete (enum, used as one interpretation)

```moonbit
enum ConcreteExpr {
  Lit(Int)
  Add(ConcreteExpr, ConcreteExpr)
  Mul(ConcreteExpr, ConcreteExpr)
}

impl ExprSym for ConcreteExpr with fn lit(n) { Lit(n) }
impl ExprSym for ConcreteExpr with fn add(a, b) { Add(a, b) }
impl MulSym for ConcreteExpr with fn mul(a, b) { Mul(a, b) }
```

### Workflow

1. **Construct** expressions using the Finally Tagless API (generic functions)
2. **Interpret** directly for operations that don't need structure (eval, show, depth)
3. **Materialize** to `ConcreteExpr` when structure is needed (optimization, serialization, debugging)
4. **Replay** a `ConcreteExpr` back through the tagless API if needed

```moonbit
fn[T : ExprSym + MulSym] replay(e : ConcreteExpr) -> T {
  match e {
    Lit(n) => T::lit(n)
    Add(a, b) => T::add(replay(a), replay(b))
    Mul(a, b) => T::mul(replay(a), replay(b))
  }
}
```

### Where the compromise lives

When a **new variant** is added (e.g., `DivSym`):

- The Finally Tagless traits: **no change**
- Existing interpretations (Eval, Show, Depth): **no change** to existing impls
- `ConcreteExpr` enum: **must be modified**
- `replay` function: **must be modified**

The key insight: *the cost of change is localized.*

**Who is this "local" to?** The localization is honest only from the *library author's* perspective — `ConcreteExpr` and `replay` live in your package, so you can edit them when adding a variant. From a **plugin author's** perspective, Two-Layer does *not* give data-axis extensibility: to ship a new variant with full structural-pass support, the plugin must edit (or coordinate an update to) the core library. And a **consumer** who writes their own `ConcreteExpr`-matching passes still faces exhaustiveness errors on every new variant — just as they would in Solution 2. The benefit of Two-Layer is limited to consumers who stay on the *tagless* API.

If you need both (a) data-axis extensibility by independent plugins and (b) structural observation on plugin-defined variants, three solutions can apply, each relaxing something different:

- **Pure Finally Tagless (Solution 1)** keeps plugins independent and exhaustive at the cost of structural passes.
- **Two-Layer (this solution)** keeps structural passes and exhaustiveness within the owning package, at the cost of an open plugin ecosystem.
- **`extenum` (Solution 1b, v0.9.2)** delivers both data-axis extensibility *and* structural matching on plugin-defined variants, at the cost of compile-time exhaustiveness (every match needs a wildcard fallback).

Pick the guarantee you are least willing to give up. Two-Layer fits when the variant set is owned by the library, structural passes need exhaustiveness, and plugins are expected to live as new *operations* rather than new variants.

### Scorecard

| Property | Status |
|----------|--------|
| New variants | ✓ (tagless + interpretations unchanged; enum + `replay` changes localized to the owning package — *not* open to independent plugins) |
| New operations | ✓ (new struct + impls) |
| Pattern matching | ✓ (via ConcreteExpr) |
| Type safety | ✓ |
| Optimization passes | ✓ (on ConcreteExpr, then replay) |

## Solution 4: open recursion with function records

An alternative to traits — represent the "algebra" as a record of functions:

```moonbit
struct ExprAlgebra {
  on_lit: (Int) -> Int
  on_add: (Int, Int) -> Int
}

fn eval_algebra() -> ExprAlgebra {
  {
    on_lit: fn(n) { n },
    on_add: fn(a, b) { a + b },
  }
}
```

### Trade-offs

- **Pro**: Does not require the trait system at all; purely value-level
- **Pro**: Algebras are first-class values (can be stored, passed, composed)
- **Con**: No type-level enforcement that all cases are handled
- **Con**: Extending with a new variant requires a new record type

## Solution 5: defunctionalized tagless (partial structure recovery)

Retain *tags* indicating which constructor was used, alongside the computed result:

```moonbit
enum ExprTag {
  TagLit
  TagAdd
  TagMul
}

struct TaggedEval {
  tag: ExprTag
  value: Int
  children_tags: Array[ExprTag]
}

impl ExprSym for TaggedEval with fn lit(n) {
  { tag: TagLit, value: n, children_tags: [] }
}
impl ExprSym for TaggedEval with fn add(a, b) {
  {
    tag: TagAdd,
    value: a.value + b.value,
    children_tags: [a.tag, b.tag],
  }
}
```

This recovers *shallow* structural information without storing the full tree. Useful for debugging and lightweight profiling.

## Solution 6: defunctionalized associated types (parameterized output)

When a Finally Tagless interpretation needs to produce a **parameterized type** (e.g., `Layout[A]`, `Tree[A]`, `Stream[A]`) where the parameter varies per use case, but MoonBit has no associated types to express this. Polymorphic trait methods do not solve this when `A` is implementation-chosen: `fn[A] to_layout(Self) -> Layout[A]` would require every implementation to produce every annotation type the caller asks for.

### Problem

```moonbit
// Cannot write — no associated types
trait Pretty {
  type Ann                        // what annotation type?
  fn to_layout(Self) -> Layout[Ann]  // Layout parameterized by Ann
}
```

### Solution

Each choice of the parameter becomes a **separate struct** implementing the same trait:

```moonbit
// Generic container
pub enum Layout[A] { Text(String); Annotate(A, Layout[A]); ... }

// Each interpretation fixes A concretely
struct PrettyLayout  { layout: Layout[SyntaxCategory], prec: Int }
struct EditorLayout  { layout: Layout[EditorAnn], prec: Int }
struct LspLayout     { layout: Layout[LspAnn], prec: Int }

// All implement TermSym — same trait, different output types
impl TermSym for PrettyLayout with fn int_lit(n) {
  { layout: annotate(Number, text(n.to_string())), prec: 5 }
}
impl TermSym for EditorLayout with fn int_lit(n) {
  { layout: annotate({ cat: Number, node_id: ... }, text(n.to_string())), prec: 5 }
}
```

Type ascription on `replay` selects the interpretation:

```moonbit
let pretty = (replay(term) : PrettyLayout).layout   // Layout[SyntaxCategory]
let editor = (replay(term) : EditorLayout).layout    // Layout[EditorAnn]
```

### Providing a trait for the default case

The most common parameterization gets a trait for method syntax:

```moonbit
pub(open) trait Pretty {
  fn to_layout(Self) -> Layout[SyntaxCategory]   // fixes A = SyntaxCategory
}

// Common case: method syntax
term.to_layout()

// Richer annotations: explicit TermSym path
(replay(term) : EditorLayout).layout
```

### What this solves

This is the Expression Problem applied to **output type parameterization**:

- **Data axis** (new annotation types): add a new struct (e.g., `DebugLayout`) — no existing code changes
- **Operation axis** (new consumers of Layout): write generic functions over `Layout[A]` — works with any annotation

### Comparison to other solutions

| Approach | How associated type is handled |
|----------|-------------------------------|
| Haskell type families | `type instance Ann MyInterp = SyntaxCategory` |
| Rust associated types | `type Ann = SyntaxCategory` inside impl block |
| MoonBit defunctionalized | Each struct fixes `Layout[A]` to a concrete `A` |

The tradeoff: you cannot write code generic over "any Pretty interpretation regardless of annotation type." Each consumer must know which struct (and therefore which `A`) it's working with. In practice this is fine — the number of annotation types is small and each consumer knows what context it's in (editor vs LSP vs plain text).

## Theoretical boundaries

A complete solution to the Expression Problem requires the ability to **abstract over types** — specifically:

1. **Existential types**: "some type that implements `ExprSym`" as a first-class value
2. **Type constructor polymorphism**: abstracting over `F[_]`
3. **Extensible variants / row polymorphism**: open sum types

MoonBit's Self-based traits still provide none of these directly: v0.10 method-local type parameters give **universal polymorphism on individual methods**, but not trait-level type parameters, associated types, existential values, or higher-kinded/type-constructor polymorphism. Finally Tagless succeeds because it cleverly avoids needing them: instead of storing "an expression" as a value, it represents expressions as **parametrically polymorphic construction processes**. As of v0.9.2, `extenum` adds a limited form of extensible variants (#3) — open sum types are now expressible at the language level — but the trade is that pattern matching loses static exhaustiveness against future additions and must default to a wildcard arm.

The price paid is the inability to observe structure. This is a fundamental trade-off:

- **Structure = closed** (enum): you can see inside, but cannot extend
- **Abstraction = open** (tagless): you can extend, but cannot see inside

The Two-Layer Architecture explicitly manages this trade-off.

## Decision guide

```
Is the set of variants fixed?
├─ Yes → Use an enum with pattern matching (Solution 2)
└─ No
   ├─ Do you need structural observation (optimization, transformation)?
   │  ├─ Yes
   │  │  ├─ Variants are added by independent plugin packages?
   │  │  │  └─ Yes → extenum (Solution 1b, v0.9.2) — accept wildcard fallback
   │  │  └─ Variants are owned by the library?
   │  │     └─ Yes → Two-Layer Architecture (Solution 3)
   │  └─ No  → Pure Finally Tagless (Solution 1)
   ├─ Do you need runtime-swappable interpretations?
   │  ├─ Yes → Function Records / Object Algebras (Solution 4)
   │  └─ No  → Finally Tagless (Solution 1)
   └─ Does interpretation output a parameterized type (Container[A])?
      └─ Yes → Defunctionalized Associated Types (Solution 6) + Finally Tagless
```

Polymorphic trait methods are a local refinement, not a separate top-level architecture choice: use them inside the chosen architecture only when the method's generic type is caller-chosen and all implementations can handle it uniformly.

## Complete example: a mini language

```moonbit
// ── Syntax traits (extensible) ──

trait ArithSym {
  fn lit(Int) -> Self
  fn add(Self, Self) -> Self
  fn neg(Self) -> Self
}

trait MulSym {
  fn mul(Self, Self) -> Self
}

// ── Interpretation: Evaluate ──

struct Eval { value: Int }

impl ArithSym for Eval with fn lit(n)      { { value: n } }
impl ArithSym for Eval with fn add(a, b)   { { value: a.value + b.value } }
impl ArithSym for Eval with fn neg(a)      { { value: -a.value } }
impl MulSym   for Eval with fn mul(a, b)   { { value: a.value * b.value } }

// ── Interpretation: Pretty-print ──

struct Pretty { repr: String }

impl ArithSym for Pretty with fn lit(n)     { { repr: n.to_string() } }
impl ArithSym for Pretty with fn add(a, b)  { { repr: "(\{a.repr} + \{b.repr})" } }
impl ArithSym for Pretty with fn neg(a)     { { repr: "(-\{a.repr})" } }
impl MulSym   for Pretty with fn mul(a, b)  { { repr: "(\{a.repr} * \{b.repr})" } }

// ── Concrete AST (for structural operations) ──

enum Ast {
  ALit(Int)
  AAdd(Ast, Ast)
  ANeg(Ast)
  AMul(Ast, Ast)
}

impl ArithSym for Ast with fn lit(n)    { ALit(n) }
impl ArithSym for Ast with fn add(a, b) { AAdd(a, b) }
impl ArithSym for Ast with fn neg(a)    { ANeg(a) }
impl MulSym   for Ast with fn mul(a, b) { AMul(a, b) }

// ── Optimization (on concrete AST) ──

fn optimize(e: Ast) -> Ast {
  match e {
    AAdd(ALit(0), x) => optimize(x)
    AAdd(x, ALit(0)) => optimize(x)
    AMul(ALit(1), x) => optimize(x)
    AMul(x, ALit(1)) => optimize(x)
    AMul(ALit(0), _) => ALit(0)
    AAdd(a, b) => AAdd(optimize(a), optimize(b))
    AMul(a, b) => AMul(optimize(a), optimize(b))
    ANeg(a) => ANeg(optimize(a))
    other => other
  }
}

// ── Replay optimized AST through any interpretation ──

fn[T : ArithSym + MulSym] replay(e : Ast) -> T {
  match e {
    ALit(n) => T::lit(n)
    AAdd(a, b) => T::add(replay(a), replay(b))
    ANeg(a) => T::neg(replay(a))
    AMul(a, b) => T::mul(replay(a), replay(b))
  }
}

// ── Usage ──

fn[T : ArithSym + MulSym] program() -> T {
  // (1 + 0) * (2 + 3)
  T::mul(T::add(T::lit(1), T::lit(0)), T::add(T::lit(2), T::lit(3)))
}

// Direct: program[Eval]() => Eval { value: 5 }
// Optimized: replay[Pretty](optimize(program[Ast]()))
```

## See also

- **`moonbit-traits`** — for trait API design patterns (Self-Closed Algebra, Fixed-Type Projection, Capability Traits, Polymorphic Methods, Callbacks/CPS, Trait Multiplication, Newtypes, Visitor). Use when the question is "how do I design a trait API?" rather than "how do I make extensible data + operations?"

## References

- Wadler, P. (1998). *The Expression Problem.* Java-genericity mailing list.
- Carette, J., Kiselyov, O., & Shan, C. (2009). *Finally Tagless, Partially Evaluated.* JFP.
- Oliveira, B. C. d. S., & Cook, W. R. (2012). *Extensibility for the Masses.* ECOOP.
- Swierstra, W. (2008). *Data Types à la Carte.* JFP.
