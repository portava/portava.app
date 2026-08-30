#!/usr/bin/env node
/**
 * check:route-auth-gate — no state-changing route may verify its own JWT.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `requireUser` (src/lib/http.ts) is the ONLY place the account ban/suspend gate
 * is applied. Banning a user writes `profiles.account_status` and nothing else —
 * there is no session revocation anywhere in this codebase, so a banned user
 * keeps holding a perfectly valid JWT.
 *
 * That makes the gate positional rather than structural: it protects a route
 * only if the route goes through requireUser. Six mutating routes in trips.ts
 * called `client.auth.getUser(token)` directly instead, and so accepted a banned
 * user's token. A banned account could still POST /trips, POST
 * /trips/:id/invite — which inserts a trip_members row AND fires a
 * `trip.invite_received` push at the target — and DELETE a member. A banned
 * harasser kept inviting people.
 *
 * Nothing failed. The routes worked exactly as designed; the design just had a
 * hole that no test could see, because every test authenticated as a user who
 * was not banned.
 *
 * So the rule is structural: if a handler writes, it authenticates through
 * requireUser. This guard fails the build otherwise, which is what stops the
 * pattern regrowing the next time someone copies a nearby handler.
 *
 * ── WHAT IS DELIBERATELY ALLOWED ────────────────────────────────────────────
 * GET handlers and optional-viewer helpers (`getViewerId`,
 * `getOptionalViewerId`, `resolveCallerId`) may call auth.getUser directly.
 * They serve public endpoints that merely enrich a response for a signed-in
 * caller and write nothing, which is what `optionalUser` in http.ts is for.
 * Converting those is a readability change, not a security one, so this guard
 * does not force it.
 *
 * src/lib/http.ts itself is exempt: it is where requireUser and optionalUser
 * live, and one of them has to make the real call.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
process.chdir(ROOT);

const ROUTES_DIR = 'src/routes';
const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

/** Helpers whose whole job is optional, read-only viewer resolution. */
const OPTIONAL_VIEWER_HELPERS = new Set([
  'getViewerId',
  'getOptionalViewerId',
  'resolveCallerId',
]);

/**
 * Attribute each auth.getUser call to the handler it sits in.
 *
 * A top-level `function`/`async function` resets the current route, so a helper
 * declared after a POST handler is not blamed on that handler — the mistake
 * that would make this guard cry wolf and get switched off.
 */
function scan(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits = [];
  let route = null;      // { method, path, line }
  let helper = null;     // name of the top-level function we are inside

  lines.forEach((line, idx) => {
    const n = idx + 1;

    const fn = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (fn) { helper = fn[1]; route = null; }

    const r = line.match(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/);
    if (r) { route = { method: r[1], path: r[2], line: n }; helper = null; }

    const code = line.replace(/\/\/.*$/, '');
    if (!/auth\.getUser\s*\(/.test(code)) return;
    if (/^\s*[*]/.test(line)) return;                       // jsdoc
    if (helper && OPTIONAL_VIEWER_HELPERS.has(helper)) return;
    if (!route || !MUTATING.has(route.method)) return;

    hits.push({ file, line: n, method: route.method.toUpperCase(), path: route.path });
  });

  return hits;
}

const files = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => join(ROUTES_DIR, f));

if (files.length === 0) {
  console.error('check:route-auth-gate — found 0 route files; discovery is broken.');
  process.exit(1);
}

// Self-test: the matcher must actually fire on a known-bad shape. Without this
// a regex typo turns the guard into a no-op that reports success forever —
// the exact failure mode the other guards in this directory were written against.
const PROBE = [
  'router.post("/probe", async (req, res) => {',
  '  const { data } = await client.auth.getUser(token);',
  '});',
].join('\n');
{
  const realRead = readFileSync;
  // eslint-disable-next-line no-global-assign
  const probeHits = (() => {
    const lines = PROBE.split('\n');
    let route = null; const out = [];
    lines.forEach((line, i) => {
      const r = line.match(/router\.(post)\(\s*["'`]([^"'`]+)/);
      if (r) route = { method: r[1] };
      if (/auth\.getUser\s*\(/.test(line) && route && MUTATING.has(route.method)) out.push(i);
    });
    return out;
  })();
  if (probeHits.length === 0) {
    console.error('check:route-auth-gate — SELF-TEST FAILED: the matcher did not flag a known-bad handler. The guard is vacuous; fix it before trusting a pass.');
    process.exit(1);
  }
  void realRead;
}

const violations = files.flatMap(scan);

if (violations.length > 0) {
  console.error(
    `\ncheck:route-auth-gate — ${violations.length} state-changing route(s) verify their own JWT ` +
      'instead of going through requireUser:\n' +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.method} ${v.path}`).join('\n') +
      '\n\nrequireUser is the only place the ban/suspend gate is applied, and banning does not revoke\n' +
      'sessions — so a banned user\'s existing token is accepted by any route that checks it itself.\n\n' +
      'Fix:\n' +
      '  const auth = await requireUser(req, res);\n' +
      '  if (!auth) return;\n' +
      '  const { client, user } = auth;\n\n' +
      'requireUser also performs the readiness and header checks, so the preamble above it goes too.\n',
  );
  process.exit(1);
}

console.log(
  `check:route-auth-gate — ${files.length} route files scanned; ` +
    'no state-changing handler verifies its own JWT.',
);
