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
import { join } from 'node:path';

const SCREEN_ROOT = 'app/(rent-a-buddy)';

/**
 * `Alert.alert(<title>, <raw>)` where <raw> is a server- or exception-supplied
 * string used directly. A `?? 'fallback'` is allowed to follow and is still a
 * violation — the fallback only fires when the value is nullish.
 */
const RAW_IN_ALERT =
  /Alert\.alert\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)\s*,\s*(?:res|result|r|err|e)\??\.(?:error|message)\b/;

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
      const lines = readFileSync(file, 'utf8').split('\n');
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
});
