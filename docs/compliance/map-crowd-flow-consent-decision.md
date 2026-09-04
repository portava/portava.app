# Crowd Flow (Map spec §10) — owner decision record

**Date:** 2026-08-31
**Decided by:** the product owner, in session, explicitly ("I give consent. All 3 approved").
**Recorded by:** Claude Code, at the owner's direction.

## Why this record exists

An engineering audit of §10 found that Crowd Flow publishes nothing, and that
two of the five things needed to change that are **not engineering decisions**:

3. a consent scope covering publication into a public aggregate
5. a `locationPurposes.ts` entry declaring lawful basis, retention, visibility
   and deletion behaviour

The audit refused to make those two on its own and stopped. This file records
that the owner subsequently made them, so the resulting code has a traceable
authority rather than resting on an agent's judgement.

## What was granted

- Creating a **new, separate consent scope** whose subject is publication of a
  traveller's declared movement into a public aggregate. Modelled on
  `intel_contribution_consent` (migration 2172, D4): **default off, explicit
  opt-in**. Absent that consent, the producer must refuse to use the signal.
- Declaring a **purpose entry** for the tables involved, recording lawful basis,
  retention bound, visibility and deletion behaviour.
- Adding an **acceptance transition** so a route plan the traveller actually
  accepted is distinguishable from one an optimizer merely generated.

## What was NOT granted, and is not open to an implementer

The grant unblocks capture. It does not touch the gates that make an aggregate
safe to publish. These stay exactly as they are:

- `MIN_SIGNAL_FAMILIES` — two independent families, still required
- `PRIVACY_THRESHOLD_V1.minUniqueActors` — the k floor, unchanged
- `maxGroupShare` — the single-group dominance cap, unchanged
- the freshness bound

Also unchanged, and not consentable: **no actor id and no trajectory may reach
any output**, origins are **zone-granular and never coordinates**, and observed
movement stays structurally separate from inferred cause.

If the second signal family turns out not to be genuinely independent, the right
outcome is still to leave §10 unsatisfied. Consent to collect is not consent to
publish something the gates say is unsafe.

## Still owed

The wording of the consent copy and the lawful-basis text was written by an
engineer against what the code actually does. **It has not been reviewed by
anyone who owns privacy policy, and should be before this ships to real users.**
The mechanism is what was authorised here; the legal characterisation is not
something this record can settle.

Production migration presses remain the owner's.
