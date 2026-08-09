# Finding 18 — there is no CI, so every guard in this repo is advisory

**Status: OPEN. Recorded deliberately without a fix, so the finding is visible
before anyone decides how to fix it.**

Date: 2026-08-09. Established by inspection, not assumed.

---

## The finding in three facts

1. **There is no CI.** No `.github/workflows/` directory exists. Nothing runs
   on push, on pull request, or on merge.

2. **`check:all` runs zero tests.** `artifacts/api-server/scripts/run-all-checks.sh`
   invokes six static checks and nothing else:
   `check:frozen-dir`, `check:async-handlers`, `check:migration-prefixes`,
   `check:test-runner-flags`, `check:write-path-columns`,
   `check:missing-live-columns`. The test suite is not among them.

3. **The curated `test` script pins Supabase to a dead address.** It begins
   `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy`. Port 9 is
   the discard protocol. Any test needing a live database and registered there
   is **guaranteed to skip — by construction, in every environment**.

---

## Why this is the headline and not a footnote

A week of work went into hardening guards: the migration-prefix collision gate,
`checkTestRunnerFlags`, the avatar/icon sizing guard, the rank-events surface
gate, the test-registration check, the admin-guard detector. Each is real and
each is correct.

**None of them runs unless a human remembers to type the command.** A guard that
only runs when someone chooses to run it does not prevent a regression; it
detects one, later, if anyone looks. The protection is advisory.

This is the same failure family the repo has already found twice, one level up:

| Instance | Shape |
|---|---|
| `check:media-objects` | A check that exits 2 without credentials — "a check that could not run must not read as one that passed" |
| `checkTestRunnerFlags` | A runner flag could silently shrink the test count, so a smaller suite still read as green |
| **Finding 18** | The whole enforcement layer only runs on human recall, so *nothing* running still reads as green |

The first two were fixed by making a check honest about not having run. Finding
18 is that same defect applied to the checks themselves — and it cannot be
fixed from inside a check, because the thing that is missing is the thing that
would invoke it.

Finding 20 belongs to this family too: `checkAdminGuard.ts` matched
`requireAdmin\w*` and was structurally blind to three guards, so it reported
them as absent rather than unexamined.

---

## The concrete consequence right now

**Finding 17 (`profiles.role` self-writable) is fixed and verified. A
regression would be silent.**

`src/test/profileRoleNotSelfWritable.test.ts` proves the boundary holds — 12
tests against a real database, every negative assertion proved capable of
failing by mutation. But:

- it needs live credentials, and
- there is no automated context that supplies them, and
- registering it into the curated `test` script would make it skip permanently
  (fact 3), producing a *green suite containing a silent skip* — precisely the
  failure mode the test exists to rule out.

So it is in `UNREGISTERED_TESTS_ALLOWLIST.json`, alongside
`rlsHardening.test.ts`, which is allowlisted for the same reason. Both must be
run deliberately:

```
pnpm run test:rls-hardening
pnpm run test:profile-role-not-self-writable
```

If someone drops `trg_profiles_role_privileged`, or runs
`GRANT UPDATE ON profiles TO authenticated`, **no automated check anywhere will
notice.** The column-level `REVOKE` and the trigger both hold today; nothing
watches them tomorrow.

---

## What a fix would need to cover — NOT done here

Deliberately not built. Scoping it is a separate decision, and the finding
should be visible before the fix is chosen. Any fix should account for:

- **Something that runs on push/PR/merge at all** — the absent primitive.
- **Two tiers of test.** The offline suite (304 registered files) needs no
  credentials. The credentialled security tests do, and must run somewhere.
- **A non-production Supabase project.** The credentialled tests create and
  delete real auth users and transiently promote a fixture to `admin`. They are
  safe against production (verified: fixtures cleaned up, role distribution
  unchanged at 55 `user` / 1 `admin`) but pointing routine automation at
  production is a poor default.
- **The 89 allowlisted tests that never run.** `check:test-registration`
  currently reports 304 registered / 89 allowlisted. The allowlist is an
  accurate record of what does not run — but "does not run" is the status quo it
  documents, not one it challenges.
- **Making a skip visible.** A skipped credentialled test should be
  distinguishable from a passing one in whatever reports the result. Today the
  distinction exists only in the console output nobody is required to read.

---

## Verification note

- Facts 1–3 were each checked directly: `ls .github/workflows` (absent), reading
  `run-all-checks.sh` in full, and reading the `test` script's literal prefix.
- The claim "guaranteed to skip by construction" follows from the test harness
  pattern (`CREDS_AVAILABLE` gating in `rlsHardening.test.ts` and
  `profileRoleNotSelfWritable.test.ts`) combined with the pinned dead URL — the
  gate cannot be satisfied by a host that is not listening.
- **Not verified:** whether any external runner (Replit scheduled job, a
  developer's git hook, a machine outside this workspace) invokes these commands
  on a schedule. Nothing in the repo configures one, but absence in the repo is
  not proof of absence everywhere.
