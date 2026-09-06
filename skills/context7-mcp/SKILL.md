---
name: context7-mcp
description: Fetch current library, framework, SDK, API, CLI, or cloud-service documentation with Context7 when a task depends on external syntax, configuration, or behavior. Pure refactoring and business-logic review do not require it.
---

# Current Library Documentation

Use Context7 when answering library-specific questions or implementing against
an external API. A library name appearing in a task does not itself require a
lookup. Reuse documentation already fetched for the same version and question.

1. Call `resolve-library-id` with the library name and the user's full question,
   unless the user supplies an exact `/org/project` library ID.
2. Choose by name and question relevance, official source reputation, version,
   snippet coverage, and benchmark score. Retry with a better query when the
   matches are unsuitable; preserve a requested version.
3. Call `query-docs` with that ID and the specific question, including the
   constraints needed to answer it.
4. Base the answer or implementation on the fetched documentation. Cite the
   supporting source and identify version limitations when relevant.

For OpenAI product questions, use the available `openai-docs` skill's official
source workflow. If Context7 is unavailable or insufficient, use the current
official documentation directly and disclose any unresolved uncertainty.
