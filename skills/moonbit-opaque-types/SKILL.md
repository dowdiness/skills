---
name: moonbit-opaque-types
description: Implements opaque/newtype pattern in MoonBit for user-friendly public APIs. Use when designing type-safe wrappers, facade layers, or hiding implementation details in MoonBit libraries.
---

# MoonBit opaque types pattern

Design pattern for creating type-safe, encapsulated wrapper types in MoonBit public APIs.

## When to use

- Building facade layers that hide library internals
- Creating type-safe wrappers (e.g., `Pos` instead of raw `Int`)
- Enforcing invariants at construction time
- Preventing accidental misuse of primitive types

## The pattern

### Basic opaque type

```moonbit
///| Type-safe text position (0-indexed, non-negative)
pub(all) struct Pos {
  priv value : Int
} derive(Debug, Eq)

suberror PosError {
  NegativePos
} derive(Debug)

///| Custom constructor with validation; call as Pos(value)
pub fn Pos::Pos(value : Int) -> Pos raise PosError {
  guard value >= 0 else { raise NegativePos }
  { value, }
}

///| Accessor
pub fn Pos::value(self : Pos) -> Int {
  self.value
}
```

### Key components

| Component | Purpose |
|-----------|---------|
| `pub(all) struct` | Type visible everywhere |
| `priv` field | Internals hidden from users |
| Custom constructor or named factory | Controlled construction with validation |
| Accessors | Controlled read access to internals |
| `derive(Debug, Eq)` | Standard traits still work |

## Important: tuple structs do not work

MoonBit does **not** support `priv` with tuple structs:

```moonbit
// ❌ WRONG - priv doesn't work with tuple structs
pub(all) struct Pos(priv Int)

// ✅ CORRECT - use named fields
pub(all) struct Pos {
  priv value : Int
}
```

## Patterns by use case

### 1. Simple wrapper (validation on construction)

```moonbit
pub(all) struct UserId {
  priv id : String
} derive(Debug, Eq, Hash)

suberror UserIdError {
  EmptyUserId
} derive(Debug)

pub fn UserId::UserId(id : String) -> UserId raise UserIdError {
  guard id.length() > 0 else { raise EmptyUserId }
  { id, }
}

pub fn UserId::to_string(self : UserId) -> String {
  self.id
}
```

### 2. Opaque wrapper (hide complex type)

```moonbit
pub(all) struct Version {
  priv frontier : @internal.Frontier
} derive(Debug, Eq)

pub fn Version::from_frontier(frontier : @internal.Frontier) -> Version {
  { frontier, }
}

pub fn Version::to_frontier(self : Version) -> @internal.Frontier {
  self.frontier
}
```

### 3. Wrapper with rich API

```moonbit
pub(all) struct Change {
  priv op : @internal.Op
} derive(Debug)

pub fn Change::from_op(op : @internal.Op) -> Change {
  { op, }
}

// Expose semantic methods, not raw access
pub fn Change::is_insert(self : Change) -> Bool {
  self.op.is_insert()
}

pub fn Change::is_delete(self : Change) -> Bool {
  self.op.is_delete()
}

pub fn Change::get_text(self : Change) -> String? {
  self.op.get_insert_text()
}
```

### 4. Escape hatch for power users

```moonbit
pub(all) struct TextDoc {
  priv inner : @internal.Document
}

// Normal API
pub fn TextDoc::text(self : TextDoc) -> String { ... }
pub fn TextDoc::insert(self : TextDoc, pos : Pos, text : String) -> Change { ... }

// Escape hatch for advanced use cases
pub fn TextDoc::advanced(self : TextDoc) -> @internal.Document {
  self.inner
}
```

## Composite types

For types with multiple fields, use regular struct:

```moonbit
pub(all) struct Range {
  start : Pos
  end : Pos
} derive(Debug, Eq)

pub fn Range::Range(start : Pos, end : Pos) -> Range {
  { start, end }
}

pub fn Range::from_ints(start : Int, end : Int) -> Range raise PosError {
  Range(Pos(start), Pos(end))
}
```

## When not to use opaque types

Use transparent tuple structs when:
- Internal representation should be public
- No invariants to enforce
- Used only internally

```moonbit
// Transparent - internal value accessible
pub(all) struct Frontier(Array[Int]) derive(Debug, Eq)
```

## Summary

| Requirement | Solution |
|-------------|----------|
| Hide internals | `priv` field in named struct |
| Enforce invariants | Factory function with validation |
| Type safety | Distinct type prevents mixing with primitives |
| Trait derivation | `derive(Debug, Eq, ...)` works normally |
| Power user access | Optional `advanced()` escape hatch |

## Related: `extenum` (the opposite direction)

Opaque types and `extenum` (v0.9.2) sit at opposite ends of the same extension axis:

| | Opaque type | `extenum` |
|---|---|---|
| Who controls the shape? | The owning package — internals hidden, no downstream extension | Downstream packages — variants can be added from anywhere |
| Pattern matching by consumers | Not possible (internals are `priv`) | Required to include a wildcard arm |
| Invariants | Enforced at construction by the factory | None at the type level — each consumer must handle unknown variants |
| Typical use | Library facade, domain wrappers, type-safe IDs | Plugin-extensible AST, open event taxonomies |

When choosing between them, pick opaque types when downstream code should avoid depending on the shape. Pick `extenum` when downstream code should add to it. They are not interchangeable; they answer different questions about who owns the type's variation. See `moonbit-expression-problem` for the full `extenum` treatment.
