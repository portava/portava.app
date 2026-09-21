# Portava architecture upgrades v2

Prepared 13 September 2026 for Compass, Discovery, and Trust, incorporating the Sensing and World Experience Intelligence upgrade. These are newly authored engineering specifications, not recovered historical documents. They define target behavior; they do not certify the current branch or deployment.

## Build upon what exists

**UPGRADE, DO NOT REBUILD. Extend existing canonical systems. Do not replace working architecture or create parallel implementations.**

Before implementation, inspect the current target commit, schema, migrations, routes, services, clients, events, projections, schedulers, permissions, flags, and tests. Map each requirement to its existing owner. Extend that owner and its real consumers. Add a narrow primitive only when a documented search establishes that no suitable owner exists. A logical contract name in these documents is not an instruction to create a table or service.

Preserve existing IDs, lifecycle semantics, authorization, privacy, user controls, API compatibility, and working user journeys. Never substitute a booking ID for a service ID or a nearby place for an unidentified activity cluster. Do not edit checksum-ledgered migrations; stage any necessary schema changes through the existing migration process. No production actions are authorized by this document.

Do not use a prescribed folder name as justification to rebuild a functioning subsystem. If relocation is required, move the existing implementation, update imports and callers, and preserve behavior. Avoid permanent compatibility facades that leave two competing owners.

## Sources and precedence

The sources directory preserves the supplied baseline documents. The three v2 documents add Sensing integration and verification requirements; they do not erase baseline scope. Read the entire applicable baseline, including Discovery's full design package and all fifteen Compass roadmap phases. A historical “done” label is a claim to verify, not evidence of current completion.

Source IDs: SENSE = Sensing World Experience Intelligence Upgrade v1; COMPASS = Compass master roadmap; C1 = Compass Phase 1 technical spec; DISCOVERY = Discovery Architecture v1 package; TRUST = Verified Foundation phased plan.

Requirement rows label their basis. “Engineering acceptance” is a new testable specification detail authored for this upgrade, not a quotation from an older document. Concrete field names are logical requirements: map them onto existing equivalents before introducing anything new.

Current explicit owner decisions take precedence. Where baseline and upgrade conflict, record the exact conflict and affected rows and ask for resolution. Do not silently treat existing code as the product specification. For missing specifications, first search the repository and referenced documents, then request the missing sections while continuing independent work.

Compass Sense (proactive assistance) and World Sensing (privacy-reduced contributions and shared intelligence) are distinct. Reuse infrastructure where appropriate, but never equate their consent, presence, identity, or retention policies.

## Shared intelligence boundary

Canonical domain entities and authorized context → shared intelligence engines → surface-specific projections → API → client → permitted action/outcome.

Consume existing equivalents of ExperienceState, ForecastState, OpportunityProjection, WorldMoment, UserNowProjection, and the Context Kernel. Clients do not independently derive crowd, vibe, safety, or opportunity truth. No second place identity, social presence system, trip lifecycle, or intelligence truth store.

Every intelligence-dependent result must preserve subject identity, truth class, confidence, coverage, provenance, and relevant times. SENSE defines OBSERVED, CORROBORATED, INFERRED, PREDICTED, CONFLICTING, STALE, and UNKNOWN. Respect existing versioned encodings and distinguish source class from truth class. Carry observation/effective/expiry times and forecast horizon where applicable. Confidence must retain its existing documented scale; do not invent a new score.

Unknown is not zero, no coverage is not quiet, crowd is not danger, inference is not observation, forecast is not current fact, and personal preference is not world truth. Expired evidence cannot authorize a live claim. Never expose contributor identity, precise trajectories, or restricted provenance through explanations, logs, tools, caches, or shared references.

Unavailable intelligence degrades explicitly to available baseline capabilities. It must not become invented live facts or silently relax safety and privacy. Apply eligibility before serving, and revalidate authorization before consequential actions. Revocation must propagate to caches, projections, queued attention, and consumers according to the canonical policy; unresolved retention policy remains a blocker.

## Integration and completion

Use independent architecture agents with bounded subagents and one integration owner. Assign explicit paths and serialize shared-file changes. Reuse or isolate worktrees as needed. Independently review agent findings. Freeze the integrated commit for its final test gate.

Build and verify in small batches, push verified commits, advance completed PRs, and keep building remaining requirements. Existing owner holds and production approval boundaries remain intact. Do not hold completed work for unrelated gaps.

For each baseline and upgrade requirement record: requirement ID, source section, canonical owner, producer, persisted state if any, consumer, route, client, authorization, flag/schema prerequisites, automated evidence, tested commit, and deployment evidence. Use N/A with a reason rather than fabricating a link.

Keep implementation, wiring, tests, merge, deployment, and production certification as separate fields. A branch test or replica rehearsal never certifies production. Map v2 IDs to existing census IDs, preserving historical counts and explicitly recording additions, splits, and genuine duplicates. Do not replace an existing denominator with the shorter upgrade checklist or count one feature twice.

Required checks include meaningful regression tests, cross-surface integration, permission failures, expiry, outage, retry, revocation, and existing unaffected journeys. For defects demonstrate failure before the fix. For critical new rules mutate the implementation to prove tests detect violations. Mocks can isolate boundaries; they cannot certify provider integration, database policy, or deployment.

Generate architecture totals from the exact tested commit. Target 100% built and correct; never report it with unresolved requirements, waived behavior, bypassed checks, or missing deployment evidence where required. Reports document ongoing work and concrete blockers rather than ending it.
