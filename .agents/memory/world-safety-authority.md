---
name: World safety authority boundary
description: Authority and fail-closed rules for shared world safety projections.
---

Shared world safety may consume only explicit constraints written through a trusted, service-only intelligence boundary. Never relabel user-owned recommendations, crowd reports, motion, or anomalies as authoritative safety evidence.

**Why:** User-owned safety-like fields can be changed by their owners and can influence cross-user projections. Promoting them creates a safety-integrity vulnerability. Missing trusted evidence must remain unknown; an explicit trusted constraint may hold, and only an explicit trusted clearance may clear.

**How to apply:** Before adding a safety source to shared projections, verify its write ownership and RLS/grants. Combine applicable constraints conservatively, retain their real expiry and provenance, and keep opportunity/Attention fail-closed unless safety is explicitly clear.