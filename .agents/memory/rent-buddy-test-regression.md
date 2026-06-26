---
name: Rent-a-buddy test regression
description: 19 rent-a-buddy tests fail with city_not_available — pre-existing, not from backlog-sweep changes
---

# Rent-a-buddy test regression

## The rule
Do not attempt to fix the 19 failing `rentABuddy.test.ts` tests as part of unrelated sweeps — they are pre-existing and require dedicated attention.

**Why:** The route now calls `checkRentBuddyAccess()` (imported from the rollout router) which emits `city_not_available` when no matching launch control exists. The test fake state in `setupState()` sets `launchControls: []`, which causes all booking-creation tests to fail because the rollout guard runs before the main booking logic.

**How to apply:** Any work touching `rentABuddy.ts` should first fix the fake state in `src/test/rentABuddy.test.ts` to include a permissive launch control row for the test city ("Shinjuku Station", category "city"). The `launchControls` array needs at least one entry with `{ city: "Shinjuku Station", category: "city", enabled: true, waitlist_only: false, ... }` in the default `setupState()` call.

The 19 failing suites: policy text, policy scanner, new-buddy restrictions, user limits, admin user limits, application.
