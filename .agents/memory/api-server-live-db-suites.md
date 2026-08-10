---
name: A green npm test covers no database behaviour
description: The api-server `test` script pins SUPABASE_URL to a dead port and omits the three live-DB suites entirely; they must be run by name with real credentials.
---

`artifacts/api-server/package.json`'s `test` script starts with:

```
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test <392 file args>
```

**The three live-database suites are not among those files.** Verified: `rlsHardening`,
`profileRoleNotSelfWritable` and `isOfficialPrivileged` appear nowhere in the `test`
script and are listed in `artifacts/api-server/scripts/UNREGISTERED_TESTS_ALLOWLIST.json`
(lines 108, 89, 53) — the omission is deliberate, not an oversight to "fix" by
adding them. Each
suite also self-disables (`describe(..., { skip: !CREDS_AVAILABLE })`) when
credentials are missing, and two of them print `A skip is not a pass.` on startup.

**Why it matters:** these suites are the only thing that exercises RLS policies,
column grants and BEFORE-INSERT/UPDATE triggers. Fake Supabase clients enforce none
of those, so against a fake client every negative assertion passes unconditionally
and asserts nothing (see the header of `src/test/isOfficialPrivileged.test.ts`).
A green `pnpm --filter @workspace/api-server test` is evidence about route logic
only. Do not report it as database-behaviour coverage.

**How to apply:** run them deliberately, by name, with real credentials in `.env`
(each script already passes `--env-file-if-exists=.env`):

```
pnpm --filter @workspace/api-server run test:rls-hardening
pnpm --filter @workspace/api-server run test:profile-role-not-self-writable
pnpm --filter @workspace/api-server run test:is-official-privileged
```

Then check the output for actual assertions — a run reporting only skips proves
nothing. When adding a negative test here, prove it can fail (run it against the
unpatched schema, or mutate it to assert the vulnerable outcome) before trusting
green. For everything else about reading this suite's results, see
[api-server-testing.md](api-server-testing.md).
