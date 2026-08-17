/**
 * Guard: no Rent-a-Buddy screen may put a raw server error code in front of a
 * user.
 *
 * The recurring failure in this area is not a missing helper — it is a helper
 * that exists and is applied at only some call sites. bookingErrorCopy() was
 * added for the three booking screens, and a survey then found 38 more places
 * across 23 Rent-a-Buddy screens still passing `res.error` (a snake_case server
 * CODE, since apiFetch drops the server's human `message`) or a caught
 * `err.message` straight into an Alert body. A user pressing "Save" saw
 * `db_error`.
 *
 * A `?? 'fallback'` does NOT fix this: it only covers null/undefined, so a
 * present code is still shown verbatim. That is why this guard matches the
 * expression rather than trusting the presence of a fallback.
 *
 * This test scans the source rather than asserting on behaviour, deliberately:
 * behaviour tests would have to render all 23 screens, and the property being
 * protected is "the helper is applied EVERYWHERE", which is a property of the
 * call sites, not of any one screen.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/rentABuddy.noRawErrorCopy.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCREEN_ROOT = 'app/(rent-a-buddy)';

/**
 * Screens outside Rent-a-Buddy that also put a service `error` in front of a
 * user. Scanned with a NARROWER rule — see OTHER_RAW_IN_ALERT.
 */
const OTHER_ROOTS = [
  'src/components/ReportSheet.tsx',
  'src/components/ReportPostSheet.tsx',
  'src/components/TelegraphInboxScreen.tsx',
  'src/components/TagPreviewSheet.tsx',
  'src/components/RichText.tsx',
  'src/components/tripCrew/CrewMapSection.tsx',
  'src/components/circle/CircleMemberRow.tsx',
  'app/u/[username].tsx',
];

const ALERT_TITLE = /Alert\.alert\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)\s*,\s*/
  .source;

/**
 * `Alert.alert(<title>, <raw>)` where <raw> is a server- or exception-supplied
 * string used directly. A `?? 'fallback'` is allowed to follow and is still a
 * violation — the fallback only fires when the value is nullish.
 *
 * Inside Rent-a-Buddy both `.error` and `.message` count: its ApiResult has no
 * `message` field at all, so any `.message` there is a caught exception.
 */
const RAW_IN_ALERT = new RegExp(
  ALERT_TITLE + String.raw`(?:res|result|r|err|e)\??\.(?:error|message)\b`,
);

/**
 * Outside Rent-a-Buddy only `.error` counts. Those services build `error` from
 * `body.message`, so `res.message` on those screens is the server's HUMAN
 * sentence and wrapping it would be the regression, not the fix.
 *
 * A ternary that already maps the code (`res.error === 'forbidden' ? … : …`,
 * circle/CheckInActions.tsx:67) is not a violation — the raw value never
 * reaches the user — so `===`/`!==`/`?` disqualify a match.
 */
const OTHER_RAW_IN_ALERT = new RegExp(
  ALERT_TITLE + String.raw`(?:res|result|r)\??\.error\b(?!\s*(?:===|!==|\?(?!\?)))`,
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('Rent-a-Buddy screens never show a raw error code', () => {
  it('has screens to scan (the guard itself must not pass vacuously)', () => {
    const files = walk(SCREEN_ROOT);
    assert.ok(files.length > 20, `expected to scan the screen tree, found ${files.length} file(s)`);
    // The pattern must be capable of matching — proven against a known-bad line
    // rather than assumed, so a broken regex cannot read as "no violations".
    assert.match("Alert.alert('Error', res.error);", RAW_IN_ALERT);
    assert.match("Alert.alert('Error', res.error ?? 'Failed');", RAW_IN_ALERT);
    assert.match("Alert.alert('Error', err?.message);", RAW_IN_ALERT);
    // ...and must NOT match the fixed form.
    assert.doesNotMatch("Alert.alert('Error', bookingErrorCopy(res.error));", RAW_IN_ALERT);
    assert.doesNotMatch(
      "Alert.alert('Error', bookingErrorCopy(res.error, 'Failed'));",
      RAW_IN_ALERT,
    );
  });

  it('no screen passes a raw error string into an Alert body', () => {
    const violations: string[] = [];
    for (const file of walk(SCREEN_ROOT)) {
      const lines = readFileSync(resolve(file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (RAW_IN_ALERT.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      violations,
      [],
      `raw error codes reach users at:\n${violations.join('\n')}\n` +
        'Wrap with bookingErrorCopy(code) — or bookingErrorCopy(code, "your fallback") ' +
        'to keep a tailored sentence.',
    );
  });

  it('the narrower rule for other screens can still detect a regression', () => {
    assert.match("Alert.alert('Error', res.error);", OTHER_RAW_IN_ALERT);
    assert.match("Alert.alert('Error', res.error ?? 'Could not block user');", OTHER_RAW_IN_ALERT);
    assert.doesNotMatch("Alert.alert('Error', errorCopy(res.error));", OTHER_RAW_IN_ALERT);
    // A ternary already maps the code — not a violation.
    assert.doesNotMatch(
      "Alert.alert('Could not check in', res.error === 'forbidden' ? 'You are not a member.' : 'Please try again.');",
      OTHER_RAW_IN_ALERT,
    );
    // `res.message` outside Rent-a-Buddy is the server's human sentence.
    assert.doesNotMatch("Alert.alert('Error', res.message ?? 'Failed');", OTHER_RAW_IN_ALERT);
  });

  it('no screen outside Rent-a-Buddy passes a raw service error into an Alert', () => {
    const violations: string[] = [];
    for (const file of OTHER_ROOTS) {
      const lines = readFileSync(resolve(file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (OTHER_RAW_IN_ALERT.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      violations,
      [],
      `raw service errors reach users at:\n${violations.join('\n')}\n` +
        'Wrap with errorCopy(value, "your fallback") from src/lib/errorCopy.ts.',
    );
  });
});
