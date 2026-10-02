/**
 * Every `ensureProfile` failure reaches Sentry.
 *
 * `ensureProfile` creating the profile row is the step that decides whether a
 * freshly signed-up account has a profile at all, and all four of its call
 * sites deliberately do NOT fail the sign-in when it throws — the row usually
 * already exists, and SessionContext has a recovery path. That choice is right
 * and this file does not change it. What it guards is the consequence: before
 * `reportEnsureProfileFailure`, those four catch blocks swallowed the error
 * outright (two of them behind `if (__DEV__) console.warn`, which reaches
 * nobody in a release build), so an account whose profile never got created
 * looked identical to one whose profile was already there. The failure was
 * real, the user saw a successful sign-in, and no one was told.
 *
 * WHAT THIS TEST CAN AND CANNOT ESTABLISH.
 *
 * It reads the three source files as text and asserts the shape: that each
 * catch block names the reporter, and that the reporter hands Sentry a user id
 * and nothing else. It does NOT execute `reportEnsureProfileFailure` and does
 * NOT establish that Sentry receives an event at runtime.
 *
 * That is a limit of the runner, not a choice. MEASURED 2026-10-02: importing
 * `src/services/auth.ts` from a node:test file fails with esbuild
 * `TransformError`, because it imports `../lib/supabase.ts` and react-native's
 * source is not valid for esbuild's Node target — the same incompatibility
 * `src/lib/sentry.ts` exists to work around, and the reason no node:test file
 * in this workspace imports `ensureProfile`. A shape test that says so is
 * worth more than a behavioural test that cannot run; it is also the thing
 * that actually regresses, since re-swallowing is a two-character edit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STANDALONE = join(HERE, '..', '..', '..');

const read = (rel: string) => readFileSync(join(STANDALONE, rel), 'utf8');

const AUTH = 'src/services/auth.ts';
const SESSION_CONTEXT = 'src/context/SessionContext.tsx';
const SIGN_IN = 'app/(auth)/sign-in.tsx';

describe('ensureProfile failures are reported, not swallowed', () => {
  it('auth.ts exports the reporter', () => {
    assert.match(
      read(AUTH),
      /export function reportEnsureProfileFailure\(/,
      'the reporter must be exported from auth.ts, since all four call sites import it from there',
    );
  });

  it('sends Sentry a user id and no other identifier', () => {
    const src = read(AUTH);
    const body = src.slice(src.indexOf('export function reportEnsureProfileFailure('));
    const reporter = body.slice(0, body.indexOf('\n}') + 2);

    assert.match(
      reporter,
      /scope\.setUser\(\{\s*id:\s*userId\s*\}\)/,
      'the reporter must identify the user by id',
    );
    for (const forbidden of ['email', 'username', 'handle', 'name:', 'ip_address']) {
      assert.ok(
        !reporter.includes(forbidden),
        `the reporter must not send ${forbidden} to Sentry — src/lib/crashReporter.ts states the convention for this codebase as "only userId (not email, name, or any other PII)", and this function's own comment claims to follow it`,
      );
    }
  });

  it('reports from all four ensureProfile call sites', () => {
    // One per site, named by the `stage` tag each passes, so a failure says
    // which flow stopped reporting rather than only that a count changed.
    const sites: Array<[string, string]> = [
      [AUTH, 'signUp'],
      [AUTH, 'signIn'],
      [SESSION_CONTEXT, 'sessionRecovery'],
      [SIGN_IN, 'sso'],
    ];
    for (const [file, stage] of sites) {
      assert.ok(
        new RegExp(`reportEnsureProfileFailure\\(\\s*['"\`]${stage}['"\`]`).test(read(file)),
        `${file} must report its ensureProfile failure with stage "${stage}" — without it that flow's failure reaches no one in a release build`,
      );
    }
  });

  it('leaves no bare catch on an ensureProfile await', () => {
    // The shape that regresses: `await ensureProfile(...)` whose catch names
    // neither the error nor the reporter. `} catch {` discards the error
    // binding itself, so nothing downstream can report what happened.
    for (const file of [AUTH, SESSION_CONTEXT, SIGN_IN]) {
      const src = read(file);
      let from = 0;
      for (;;) {
        const at = src.indexOf('await ensureProfile(', from);
        if (at === -1) break;
        from = at + 1;
        const after = src.slice(at, at + 1200);
        const catchAt = after.search(/\}\s*catch\s*(\{|\()/);
        if (catchAt === -1) continue; // not inside a try at this site
        const handler = after.slice(catchAt, catchAt + 600);
        assert.ok(
          handler.includes('reportEnsureProfileFailure'),
          `${file}: the catch guarding an \`await ensureProfile(...)\` does not call reportEnsureProfileFailure, so that failure is swallowed again`,
        );
      }
    }
  });

  it('does not turn a non-fatal failure into a blocked sign-in', () => {
    // The inverse, pinned so the fix cannot be over-applied. Reporting is
    // observability; it must not start rethrowing or returning an error, which
    // would fail sign-in for the common case where the profile row already
    // exists.
    const src = read(AUTH);
    const body = src.slice(src.indexOf('export function reportEnsureProfileFailure('));
    const reporter = body.slice(0, body.indexOf('\n}') + 2);
    assert.ok(
      !/\bthrow\b/.test(reporter),
      'the reporter must never throw — it runs inside a catch whose whole purpose is not to fail the caller',
    );
    assert.match(
      src,
      /export function reportEnsureProfileFailure\([^)]*\):\s*void/,
      'the reporter returns void, so no call site can accidentally branch on it',
    );
  });
});
