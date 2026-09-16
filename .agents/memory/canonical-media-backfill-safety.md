---
name: Canonical media backfill safety
description: Why existing canonical assets must not be reconciled with the legacy destructive upsert script.
---

Do not run the legacy canonical-media backfill over assets that already exist. It upserts guessed MIME types, zero byte sizes, and a processing state, which can overwrite authoritative canonical metadata. Reconcile historical assets with attachment-only writes after exact entity matching; use the canonical writer for new uploads.

**Why:** Canonical assets can predate their attachment rows. Re-running the original seed-oriented backfill would repair links by degrading valid asset metadata and readiness.

**How to apply:** Before any Media attachment backfill, compare asset and attachment counts, inspect whether assets already exist, and use deterministic storage/entity references. Never infer an entity link or mutate existing asset metadata just to close parity.