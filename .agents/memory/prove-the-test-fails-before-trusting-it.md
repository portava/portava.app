---
name: Prove a test fails before trusting it — and model stubs on captured responses, not expectations
description: A round-trip test written to catch a real defect passed with the fix reverted, because its fetch stub returned success regardless of URL; the repair required a real production error response to model the stub on, which only existed because an observability fix had shipped first.
---

**A test you have only ever seen pass is not evidence. It is a test-shaped object.**

Observed 2026-08-15. A round-trip test was written specifically to catch a defect
that two separately-correct API routes had hidden between them — one emitted
`google-<id>`, the other required a bare `<id>`, and only a `.replace()` on the
client bridged them. The test was then reverted-and-rerun to prove it would fail.

**It passed.**

## Why, and it generalises

The test drove the route through a **fetch stub that returned success regardless
of the URL it was handed.** A stub that cannot see a wrong request cannot detect
one. The test exercised the code, asserted on the response, and was
**structurally incapable of failing** for the defect it was written to catch.

This is *vacuity is failure* — a check that examines nothing passes — occurring
**inside a test written by someone actively thinking about vacuity**, the same
day, in the same workstream. Knowing the failure mode is not protection from it.

## The repair, and the dependency that does not transfer for free

The stub was changed to answer the way **production actually did**:
`INVALID_ARGUMENT` for a namespaced id. Result: **3 failures with the fix
reverted, 22/22 with it.**

That was only possible because a **real production response existed to model the
stub on** — and it existed because an observability fix had shipped hours earlier
and put the upstream's actual error on the wire. Before that, the same call
returned an empty success and said nothing.

**Three things earned each other, in order:**

1. the observability fix made the real failure *speak*;
2. a live probe captured what it actually said;
3. a stub modelled on that answer made the test able to fail.

**Remove any one and the test is still green and still worthless.**

## Why invented stubs fail this way so reliably

A stub written from imagination models the API you **expect** — which is the same
API your code already assumes. The stub and the code share the misconception, so
they agree, and the test confirms the agreement rather than the behaviour.

## How to apply

- **Break the fix, watch the test go red, restore it.** For every test that
  guards a specific defect, not only the important-looking ones. It costs a
  minute and it is the only thing that distinguishes a test from a ritual.
- **Distrust a stub that never rejects.** If no input makes it return an error,
  it is scenery. Give it at least one input it refuses.
- **Assert on the REQUEST, not only the response**, whenever the defect could be
  "we called the wrong thing." Response-only assertions are blind to wrong URLs,
  wrong methods, wrong headers and wrong bodies.
- **Model stubs on captured real responses.** Paste the actual error body into
  the test. If you cannot capture one because the system is silent on failure,
  that silence is the first defect to fix — and fixing it is what makes the test
  possible.

Related: `docs/discovery/ROADMAP.md` — the governing invariant and its faces.
