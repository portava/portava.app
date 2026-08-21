---
name: JSONB CHECK null semantics
description: Missing JSON keys can make PostgreSQL CHECK expressions evaluate to NULL and pass.
---

For privacy-sensitive JSONB columns, a value-shape `CHECK` is not enough: explicitly require every permitted key (for example with `?&`) or coalesce each predicate to false.

**Why:** PostgreSQL rejects a `CHECK` only when its expression is false. A missing JSON key often makes `jsonb_typeof(...)` and comparisons evaluate to NULL, so an apparently strict shape constraint can accept an object that omits the checked field.

**How to apply:** Whenever a JSONB constraint is meant to be closed-schema, enforce object type, exact/allowed keys, required keys, and value shapes independently. Include a test for `{}` and partially missing objects.