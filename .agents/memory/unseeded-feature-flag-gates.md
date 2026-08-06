---
name: Unseeded feature flags silently disable entry points
description: A flag key referenced in code (and even mocked true in tests) but never inserted into the live feature_flags table defaults to disabled with no error.
---

`FeatureFlagsContext.isEnabled(key)` returns `false` for any flag key with no
matching row in the live `feature_flags` table — this is by design ("unknown
flag = hidden entry point"), but it means a typo'd or never-seeded flag name
fails completely silently: no error, no log, just a permanently-missing UI
entry point that looks like a deliberate design choice.

Concrete case: `MediaQuickCreateSheet` gated its "Add a Gem" entry on
`MEDIA_HIDDEN_GEMS_CREATE_ENABLED`. Component tests mocked this flag `true`
(passing green), and code comments described it as the intended on-switch —
but the row was never inserted into the live `feature_flags` table, so in
every real environment the entry was invisible regardless of Gems mode being
active. Fixed by inserting the missing row (`enabled: true`).

**Why:** tests mock flags in-process, so a missing DB row never fails CI —
only live/manual testing surfaces it, and it looks identical to "feature not
built yet."

**How to apply:** when a reported bug is "an option/entry point that should
exist is just absent, with no error," check `isEnabled('THE_FLAG_KEY')`'s
backing row in `feature_flags` directly (`select * from feature_flags where
flag ilike '%...%'`) before assuming it's a rendering/logic bug — grep code
for the exact flag key string and confirm a matching row exists and is
enabled.
