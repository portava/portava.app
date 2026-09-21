# Implementation command

Read 00-START-HERE.md, the three v2 specifications, and their bundled baseline sources in full. These are newly authored upgrades. Build upon existing Portava architecture: do not rebuild working systems or introduce duplicate owners. Map every baseline and upgrade requirement to the current repository and census before implementing. Preserve existing behavior and document any source conflict or missing policy rather than guessing.

Use multiple architecture agents and bounded subagents with explicit ownership and a single integration owner. Implement, wire, independently test, integrate, push verified batches and continue toward 100% constructed and correct across all architectures. Keep unaffected journeys passing. Do not replace the original census denominator with these shorter upgrade checklists or mistake code presence for correctness.

Ask for missing specifications and unresolved product policies, including Trust scoring/override semantics where no approved source exists, while continuing all independent work. Keep existing holds and production approval boundaries. Report the exact tested commit, reproducible counts, regression evidence, deployment state and concrete blockers. Reports are progress records, not stopping points.
