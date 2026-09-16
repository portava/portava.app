---
name: Independent-group denominator
description: Privacy rule for calculating dominant-group share when contributors can appear in multiple groups.
---

For privacy publication gates, calculate dominant-group share as the largest group's distinct actor count divided by the distinct union of all actors carrying any certified group key. Never divide by the sum of per-group membership counts.

**Why:** Overlapping memberships otherwise count the same people repeatedly in the denominator. The same correlated cohort can submit under multiple group keys and appear independent enough to pass a rare-path or crowd threshold.

**How to apply:** Use this denominator for both fresh cohorts and historical support. Add an overlapping-group regression whenever a new aggregate counts independent contributors.