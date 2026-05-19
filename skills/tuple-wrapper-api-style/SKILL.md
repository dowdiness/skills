---
name: tuple-wrapper-api-style
description: Guidance for tuple struct wrapper APIs that use public named constructors and internal tuple constructors; use when designing newtypes/wrappers, deciding constructor visibility, or documenting public vs internal usage.
---

# Tuple Wrapper API Style

## Goals
- Keep public API stable by hiding representation details.
- Keep internal code concise with tuple constructor and `.0` access.

## Pattern
- Public: provide named constructors (e.g., `new`, `from_array`) and avoid exposing `.0` in docs or external examples.
- Internal: use tuple constructor `Type(value)` and `.0` access for brevity.

## When to apply
- Use on newtype wrappers, identifiers, or semantic wrappers (e.g., `Frontier`, `VersionVector`, `AgentId`).
- Skip for rich structs with many fields or where field names are clearer than a tuple.

## Implementation checklist
- Define wrapper as tuple struct: `pub struct Type(T)`.
- Add minimal public constructors (e.g., `pub fn Type::new()`, `pub fn Type::from_x(...)`).
- Keep internal code using `Type(value)` and `value.0`.
- Update docs/examples to show named constructors only.
- Use `.0` in tests only when they are internal package tests; avoid in public API examples.
