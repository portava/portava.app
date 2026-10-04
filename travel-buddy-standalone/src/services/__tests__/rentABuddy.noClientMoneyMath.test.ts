/**
 * Rent-a-Buddy screens show the money figures they are GIVEN. They do not
 * compute a fee, a net, a deposit or a cash balance, and they do not claim
 * money was collected (payments PAY-055, PAY-009; owner rulings 2026-10-04:
 * 10 % commission resolved from configuration, no commission on tips, no
 * deposit in the first release).
 *
 * WHAT THIS REPLACED. Six screens each carried their own arithmetic:
 *
 *   booking/[id].tsx              deposit = total × 0.3, service fee = total × 0.12,
 *                                 cash to buddy = total × 0.7
 *   active.tsx                    cash balance = total × 0.7
 *   buddy-dashboard/earnings.tsx  fee = total × 0.1, you keep = total × 0.9,
 *                                 "this week" = this month ÷ 4
 *   buddy-dashboard/requests.tsx  you earn = total × 0.9
 *   buddy-dashboard/earnings-ledger.tsx   "Fee {percent ?? 22}%", "Deposit collected"
 *   admin/fee-rules.tsx           a worked example charging the traveller a fee
 *
 * None of those numbers came from the server, and none matched the booking's
 * ledger (which is priced from configuration, in the database). The screens'
 * behaviour is asserted by their component tests; this file is the ratchet that
 * stops the arithmetic coming back in a seventh place, by reading every screen
 * under app/(rent-a-buddy) as text.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/rentABuddy.noClientMoneyMath.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const RAB = join(APP_ROOT, 'app', '(rent-a-buddy)');

function screens(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__') continue;
    if (statSync(p).isDirectory()) screens(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Code only: comments are where the removed arithmetic is supposed to be named. */
function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const FILES = screens(RAB);
const rel = (f: string) => relative(APP_ROOT, f);

describe('Rent-a-Buddy screens do no money arithmetic', () => {
  it('scans every screen under app/(rent-a-buddy), so the scan is not vacuous', () => {
    assert.ok(FILES.length >= 40, `expected the lane's screens, found ${FILES.length}`);
    for (const must of ['checkout.tsx', 'active.tsx', 'booking/[id].tsx', 'buddy-dashboard/earnings.tsx',
      'buddy-dashboard/earnings-ledger.tsx', 'buddy-dashboard/requests.tsx', 'admin/payouts.tsx', 'admin/fee-rules.tsx']) {
      assert.ok(FILES.some((f) => f.endsWith(join('(rent-a-buddy)', must))), `${must} was not scanned`);
    }
  });

  it('no screen multiplies a booking total, price or amount by a literal fraction', () => {
    // `total × 0.9`, `amount * 0.3`, `price * (1 - …)`: a percentage applied on
    // the screen. Layout maths (widths, opacities, durations) is not money and
    // is not matched: the left operand must name a money figure.
    const MONEY = /(?:total|price|amount|usd|fee|deposit|earn|net|gross|balance|tip)\w*/i;
    const re = new RegExp(`${MONEY.source}\\)?\\s*\\*\\s*(?:0?\\.\\d+|\\(\\s*1\\s*-)`, 'i');
    const hits = FILES.filter((f) => re.test(code(readFileSync(f, 'utf8')))).map(rel);
    assert.deepEqual(hits, [],
      'a screen applies a fraction to a money figure. The fee, the net and any split are folded by the database ' +
      '(rb_post_booking_ledger / rb_buddy_ledger_totals); show the figure the server sent.');
  });

  it('no screen derives a fee from a percentage', () => {
    const re = /(?:fee_?percent|feePercent|fee_pct|feePct|commission\w*)\s*\/\s*100|\/\s*100\s*\)?\s*\*|\*\s*\(?\s*\w*(?:fee_?percent|feePercent)\w*/i;
    const hits = FILES.filter((f) => re.test(code(readFileSync(f, 'utf8')))).map(rel);
    assert.deepEqual(hits, [], 'a screen turns a percentage into an amount; the amount is a ledger figure');
  });

  it('no screen substitutes a fee percentage of its own for a missing one', () => {
    const re = /(?:platformFeePercent|platform_fee_percent|feePercent)\s*\?\?\s*\d/;
    const hits = FILES.filter((f) => re.test(code(readFileSync(f, 'utf8')))).map(rel);
    assert.deepEqual(hits, [], '`?? 22` printed an invented rate on a buddy\'s ledger row');
  });

  it('no screen says a deposit was collected, or that one is forfeited', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = code(readFileSync(f, 'utf8'));
      if (/Deposit collected/i.test(src)) offenders.push(`${rel(f)}: "Deposit collected"`);
      if (/forfeit the deposit/i.test(src)) offenders.push(`${rel(f)}: "forfeit the deposit"`);
      if (/deposit refund/i.test(src)) offenders.push(`${rel(f)}: "deposit refund"`);
      if (/non-?refundable/i.test(src)) offenders.push(`${rel(f)}: "non-refundable"`);
    }
    assert.deepEqual(offenders, [],
      'no deposit is taken in this release and nothing is collected through the app; the owner ruling is also ' +
      '"don\'t promise that fees or deposits are non-refundable"');
  });

  it('the two earnings screens and the checkout read their figures from the service, not from a constant', () => {
    const ledger = code(readFileSync(join(RAB, 'buddy-dashboard', 'earnings-ledger.tsx'), 'utf8'));
    assert.match(ledger, /getEarningsSummary\(\)/);
    assert.match(ledger, /summary\.completed\.inAppAmountCollected/);
    assert.equal(/depositCollected/.test(ledger), false, 'the deprecated alias must not be what the screen renders');

    const earnings = code(readFileSync(join(RAB, 'buddy-dashboard', 'earnings.tsx'), 'utf8'));
    assert.match(earnings, /getEarningsSummary\(\)/);
    assert.match(earnings, /entry\.platformFeeAmount/);
    assert.match(earnings, /entry\.buddyNetEstimatedAmount/);

    const checkout = code(readFileSync(join(RAB, 'checkout.tsx'), 'utf8'));
    assert.match(checkout, /getCommissionQuote\(buddyId, category\)/);
    assert.match(checkout, /commission\.quote\.platformFeePercent/);
    assert.equal(/platformFeePercent\s*[:=]\s*\d/.test(checkout), false, 'the checkout must not hold a rate of its own');
  });

  it('the payouts screen says no real money moves', () => {
    const payouts = readFileSync(join(RAB, 'admin', 'payouts.tsx'), 'utf8');
    assert.match(payouts, /no real money moves/i);
    assert.match(payouts, /Nothing is paid to anyone/);
  });
});
