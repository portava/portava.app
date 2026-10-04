/**
 * PAY-T03 — the architecture pins around the payment-provider seam.
 *
 *   PA1  NO LEDGER MODULE IMPORTS A PROVIDER. `09_Payment_Architecture.md` §9:
 *        "Do not tightly couple core ledger to one provider." The ledger records
 *        what happened; it must be able to do that whichever provider — or no
 *        provider — is configured. Pinned for:
 *          services/payments/PaymentLedger*.ts   (the payment ledger, PAY-T05/06)
 *          lib/rentBuddyEarningsLedger.ts
 *          lib/creatorLedgerEntries.ts
 *   PA2  the pin can fail: the same scanner flags every import form of every
 *        provider module, and passes a clean file
 *   PA3  the provider modules perform no I/O and do not import a ledger; the
 *        fake uses no wall clock and no randomness
 *   PA4  the older PayoutProvider module is byte-for-byte free of imports — the
 *        new seam sits behind it without editing it
 *
 * Static: reads source files only.
 * Run: node --import tsx/esm --test src/test/paymentProviderArchitecture.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every module that IS a provider, a provider's registry, or a provider's
 * credential/readiness logic — repo-relative to src/, without extension.
 * An adapter added later (PAY-T04's StripePaymentProvider) is covered by the
 * `*Provider` rule below and should also be named here.
 */
const PROVIDER_MODULES = [
  "services/payments/PaymentProvider",
  "services/payments/FakePaymentProvider",
  "services/payments/TaxProvider",
  "services/payments/providerRegistry",
  "services/payments/payoutSeam",
  "services/payments/paymentWebhookSignature",
  "services/payments/readiness",
  "services/creators/PayoutProvider",
  "lib/paymentsMode",
] as const;

/** Third-party payment SDKs a ledger must never reach for. */
const PROVIDER_PACKAGES = /^(stripe|@stripe\/|paypal|@paypal\/|adyen|@adyen\/|braintree|square)/;

/** Every module specifier a source file names: static, type-only, re-export, dynamic import and require. */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"()]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const p of patterns) for (const m of source.matchAll(p)) found.push(m[1] as string);
  return found;
}

/** The provider modules and SDKs `source` (living at src-relative `file`) imports. Empty means clean. */
function providerImports(file: string, source: string): string[] {
  const offending: string[] = [];
  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith(".")) {
      if (PROVIDER_PACKAGES.test(spec)) offending.push(spec);
      continue;
    }
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.(js|ts|mjs|cjs)$/, "");
    const base = posix.basename(resolved);
    const isProvider =
      (PROVIDER_MODULES as readonly string[]).includes(resolved) ||
      (resolved.startsWith("services/payments/") && /Provider$/.test(base));
    if (isProvider) offending.push(spec);
  }
  return offending;
}

/** The ledger modules that exist in this tree. The two lib ledgers must exist; PaymentLedger* joins when it lands. */
function ledgerModules(): string[] {
  const fixed = ["lib/rentBuddyEarningsLedger.ts", "lib/creatorLedgerEntries.ts"];
  for (const f of fixed) assert.ok(existsSync(join(SRC, f)), `${f} is a ledger module this pin names; it has moved`);
  const dir = join(SRC, "services/payments");
  const paymentLedger = readdirSync(dir).filter((f) => /^PaymentLedger.*\.ts$/.test(f)).sort().map((f) => `services/payments/${f}`);
  return [...fixed, ...paymentLedger];
}

describe("PA1 — no ledger module imports a provider", () => {
  it("lib/rentBuddyEarningsLedger.ts, lib/creatorLedgerEntries.ts and every services/payments/PaymentLedger*.ts are provider-free", () => {
    const files = ledgerModules();
    assert.ok(files.length >= 2, `scanned ${files.length} files`);
    for (const f of files) {
      const source = readFileSync(join(SRC, f), "utf8");
      assert.deepEqual(providerImports(f, source), [], `${f} imports a payment provider; the ledger must not know one exists`);
      assert.ok(!/\bfetch\s*\(|from\s+["']node:(https?|net|tls)["']/.test(source), `${f} reaches the network`);
    }
  });
});

describe("PA2 — the pin can fail", () => {
  const ledgerAt = "services/payments/PaymentLedger.ts";

  it("flags every import form of every provider module from a ledger's location", () => {
    for (const mod of PROVIDER_MODULES) {
      const relative = posix.relative(posix.dirname(ledgerAt), mod);
      const spec = `${relative.startsWith(".") ? relative : `./${relative}`}.js`;
      const forms = [
        `import { x } from "${spec}";`,
        `import type { X } from "${spec}";`,
        `import x, { type Y } from '${spec}';`,
        `import * as p from "${spec}";`,
        `import "${spec}";`,
        `export { x } from "${spec}";`,
        `export type { X } from "${spec}";`,
        `export * from "${spec}";`,
        `const p = await import("${spec}");`,
        `const p = require("${spec}");`,
        `import {\n  a,\n  b,\n} from "${spec}";`,
      ];
      for (const form of forms) assert.deepEqual(providerImports(ledgerAt, form), [spec], `${mod}: ${form}`);
    }
  });

  it("flags a future adapter by name, a payment SDK, and the same module from lib/", () => {
    assert.deepEqual(providerImports(ledgerAt, `import { s } from "./StripePaymentProvider.js";`), ["./StripePaymentProvider.js"]);
    assert.deepEqual(providerImports(ledgerAt, `import Stripe from "stripe";`), ["stripe"]);
    assert.deepEqual(providerImports(ledgerAt, `import { loadStripe } from "@stripe/stripe-js";`), ["@stripe/stripe-js"]);
    assert.deepEqual(providerImports("lib/rentBuddyEarningsLedger.ts", `import { getPaymentProvider } from "../services/payments/providerRegistry.js";`), ["../services/payments/providerRegistry.js"]);
    assert.deepEqual(providerImports("lib/creatorLedgerEntries.ts", `import { liveAllowed } from "./paymentsMode.js";`), ["./paymentsMode.js"]);
    assert.deepEqual(providerImports("lib/creatorLedgerEntries.ts", `import type { PayoutProvider } from "../services/creators/PayoutProvider.js";`), ["../services/creators/PayoutProvider.js"]);
  });

  it("passes a clean ledger, a look-alike name, and a word in a comment", () => {
    const clean = [
      `import { isFlagEnabled } from "../../lib/featureFlags.js";`,
      `import { toMinor } from "../../lib/creatorLedgerEntries.js";`,
      `import { readiness } from "../identityVerification/readiness.js";`,
      `import { x } from "./PaymentLedgerRows.js";`,
      `// the provider (see ./PaymentProvider.js) is deliberately not imported here`,
      `const provider = "none"; const s = "import x from PaymentProvider";`,
    ].join("\n");
    assert.deepEqual(providerImports(ledgerAt, clean), []);
  });
});

describe("PA3 — the provider modules do no I/O and know no ledger", () => {
  const OWN = [
    "services/payments/PaymentProvider.ts",
    "services/payments/FakePaymentProvider.ts",
    "services/payments/TaxProvider.ts",
    "services/payments/providerRegistry.ts",
    "services/payments/payoutSeam.ts",
    "services/payments/paymentWebhookSignature.ts",
    "services/payments/paymentEventFold.ts",
    "services/payments/readiness.ts",
  ];

  it("no network, filesystem, process or database primitive, and no third-party package", () => {
    for (const f of OWN) {
      const source = readFileSync(join(SRC, f), "utf8");
      for (const spec of importSpecifiers(source)) {
        assert.ok(spec.startsWith(".") || spec === "node:crypto", `${f} imports ${spec}; these modules import repo files and node:crypto only`);
      }
      assert.ok(!/\bfetch\s*\(/.test(source), `${f} calls fetch`);
      assert.ok(!/\bfrom\(\s*["'][a-z_]+["']\s*\)|\.rpc\(/.test(source), `${f} talks to the database`);
    }
  });

  it("no provider module imports a ledger", () => {
    for (const f of OWN) {
      const source = readFileSync(join(SRC, f), "utf8");
      for (const spec of importSpecifiers(source)) {
        assert.ok(!/Ledger/i.test(spec), `${f} imports ${spec}; a provider must not know the ledger either`);
      }
    }
  });

  it("the fake reads no wall clock, uses no randomness and schedules nothing", () => {
    const source = readFileSync(join(SRC, "services/payments/FakePaymentProvider.ts"), "utf8");
    for (const [name, pattern] of [
      ["Date.now()", /\bDate\.now\s*\(/],
      ["new Date() with no argument", /\bnew\s+Date\s*\(\s*\)/],
      ["Math.random()", /\bMath\.random\s*\(/],
      ["randomUUID / randomBytes", /\brandom(UUID|Bytes|Int)\s*\(/],
      ["setTimeout / setInterval", /\bset(Timeout|Interval|Immediate)\s*\(/],
    ] as const) {
      assert.ok(!pattern.test(source), `the fake uses ${name}; it must be deterministic`);
    }
  });
});

describe("PA4 — the older payout seam is not edited", () => {
  it("services/creators/PayoutProvider.ts still imports nothing and still exports the none provider and its resolver", () => {
    const source = readFileSync(join(SRC, "services/creators/PayoutProvider.ts"), "utf8");
    assert.deepEqual(importSpecifiers(source), []);
    for (const name of ["NONE_PAYOUT_PROVIDER", "NONE_PROVIDER_ID", "resolvePayoutProvider", "PayoutProvider"]) {
      assert.match(source, new RegExp(`export (const|function|interface) ${name}\\b`), name);
    }
    const seam = readFileSync(join(SRC, "services/payments/payoutSeam.ts"), "utf8");
    assert.ok(importSpecifiers(seam).includes("../creators/PayoutProvider.js"), "the seam is built ON the old module, not beside it");
  });
});
