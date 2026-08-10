# check:guard-coverage ships UNWIRED, deliberately

`apply-drop2.sh` installs `artifacts/api-server/scripts/check-guard-coverage.mjs`
and adds the `check:guard-coverage` script to `package.json`, but it does **not**
add it to `scripts/run-all-checks.sh`. That last step is yours, and only after
the check is green on your tree.

## Why

The check is fail-closed, and it would be inserted at the TOP of
`run-all-checks.sh`, gating every other check. This drop was built against a
clone that is BEHIND your repo. Roughly 6% of the files under
`artifacts/api-server/src/` match its reachability patterns, so any file you or
Claude Code added since — anything naming `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_PROJECT_TOKEN`,
`EXPO_PUBLIC_SUPABASE_*`, or calling `createClient(` — will fail it until it is
either guarded or added to the EXEMPT list with a written reason.

That is the check working. It is not a reason to wire it in blind and discover
it by watching `check:all` go red on unrelated work.

## Do this, in order

1. Run it, and read the output rather than the exit code:

       cd artifacts/api-server && pnpm run check:guard-coverage

2. If it is green, wire it. Insert this immediately before the
   `check:frozen-dir` line in `artifacts/api-server/scripts/run-all-checks.sh`
   (the exact text is in `_drop2/blocks/run-all-checks.insert`):

       run_check "check:guard-coverage" pnpm run check:guard-coverage

3. If it is RED, it will name each file it could not account for. For each one,
   decide deliberately:
     * CI invokes it and it can reach Supabase  -> add the guard import
     * it is manual ops tooling CI never runs   -> add an EXEMPT entry whose
       reason says what it does AND that an exemption means the file is
       unguarded, not that it is safe
   Then re-run, and wire it only once green.

Do not silence it by deleting entries or widening a pattern. A check that was
made to pass by weakening it is worth less than no check.
