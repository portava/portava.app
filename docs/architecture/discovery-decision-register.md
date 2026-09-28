# Discovery decision register

Owner authorisation, 2026-09-28. These instructions come from the owner:

- The 2026-08-15 ranker implementation hold is lifted. The held designs may be built and tested behind flags seeded FALSE.
- Routine architecture and product decisions are to be made from the specifications, recorded here, and implemented.
- Four kinds of decision are NOT delegated:
  - real user consent;
  - financial obligations (rates, payouts, commercial terms);
  - data-retention policy;
  - production activation (production migrations, deploys, flags turned on in production).

  For each of those this register carries an exact recommended action and a specific approval request. Nothing is chosen silently.

Each lane appends its own `## <lane> — <topic>` section and never edits another lane's section. An entry has:

- **Decision id:** `D-<lane>-<n>`.
- **The question:** quoted from the census section or spec that raised it, with a citation.
- **Options considered:** each with its consequence.
- **Decision and rationale:** with spec citations.
- **Reversibility:** how to undo it, and whether anything is lost.
- **Where it is implemented:** file references, plus the tests that pin it.

An entry that needs owner approval is marked **APPROVAL REQUIRED**. It gives the recommended action with exact values, the consequence of approving, the consequence of declining, and the recovery path.
