---
name: Shared dev/prod background-job queue
description: Dev and the production deployment share one Supabase DB — background jobs enqueued from dev get executed by the prod worker.
---

# Shared dev/prod background-job queue

Dev workspace and the production deployment point at the SAME Supabase database. DB-backed job queues (e.g. stamp generation jobs enqueued by the stamps reconciler) have workers running in BOTH environments, and the prod deployment's worker can pick up jobs enqueued from dev within seconds.

**Why:** Observed live — a reconcile triggered against the local dev API enqueued 2 stamp-generation jobs; the production deployment's logs showed it processing (and permanently failing) them moments later.

**How to apply:**
- Anything enqueued during dev testing WILL run with prod's env/provider config — don't assume dev-side experiments stay in dev.
- When triaging prod worker errors, check whether the triggering row actually came from dev activity.
- Related live finding (July 2026): the stamp image pipeline requested model `dall-e-3`, which the Replit AI-integrations OpenAI proxy rejects with `400 Model 'dall-e-3' is not supported` (permanent failure). Image generation through the proxy needs a supported model (e.g. gpt-image-1) — check the ai-integrations-openai skill for the current list.
