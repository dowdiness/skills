# Sources

This directory is reserved for source repositories used to generate or sync skills.

The initial import copied MoonBit skills from the local `dowdiness/moonbit-skills` checkout after commit `c9b8b08`. Those community MoonBit skills now sync through the `vendor/dowdiness/moonbit-skills` submodule.

External MoonBit skills from `moonbitlang/moonbit-agent-guide` now sync through the `vendor/moonbitlang/moonbit-agent-guide` submodule. The `incr` and `loom` skills are treated as vendored user-owned library skills from `dowdiness/incr` and `dowdiness/loom`.

Future generated skills should record their source repository and revision in `meta.ts` before copying into `skills/`.
