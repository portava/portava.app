---
name: PostgREST timestamp claim checks
description: Why database-backed execution claims must compare timestamptz values by instant rather than raw serialization.
---

For database-backed claim verification, keep identity, status, and random-token
checks exact, but compare `timestamptz` values as parsed instants after rejecting
missing or invalid values.

**Why:** PostgREST can return the same UTC timestamp with a `+00:00` suffix after
the application submitted it with `Z`. A byte-for-byte check falsely rejected a
successfully stored deletion claim and left it in the leased state.

**How to apply:** Any service that writes a timestamp and validates the returned
row should include a regression case for equivalent UTC serializations. Do not
weaken token, owner, or state comparisons while normalizing timestamp equality.