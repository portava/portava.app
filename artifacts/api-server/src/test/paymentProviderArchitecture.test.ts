/**
 * PAY-T03 — the architecture pins around the payment-provider seam.
 *
 *   PA1  NO LEDGER MODULE IMPORTS A PROVIDER. `09_Payment_Architecture.md` §9:
 *        "Do not tightly couple core ledger to one provider." The ledger records
 *        what happened; it must be able to do that whichever provider — or no
 *        provider — is configured. Pinned, by path, for:
 *          lib/rentBuddyEarningsLedger.ts            (must exist)
 *          lib/creatorLedgerEntries.ts               (must exist)
 *          lib/rentBuddyLedgerPosting.ts             (PR #603; scanned when present)
 *          services/payments/PaymentLedger.ts        (PR #598; scanned when present)
 *          services/payments/PaymentLedger*.ts       (anything else by that name)
 *   PA2  the pin can fail: the same scanner flags every import form of every
 *        provider module, and passes what the rule allows
 *   PA3  the provider modules perform no I/O and do not import a ledger; the
 *        fake uses no wall clock and no randomness
 *   PA4  the older PayoutProvider module is byte-for-byte free of imports — the
 *        new seam sits behind it without editing it
 *
 * ── THE RULE, STATED ─────────────────────────────────────────────────────────
 * What a ledger module may and may not name:
 *
 *   1. NO VALUE IMPORT of any provider module, in any form (named, default,
 *      namespace, side-effect, re-export, dynamic `import()`, `require`), and no
 *      payment SDK package. A value import is a runtime dependency: the ledger
 *      could call the provider, and would load with it.
 *   2. A TYPE-ONLY import is allowed from the two modules that DEFINE the
 *      contract's data — `services/payments/PaymentProvider` and
 *      `services/payments/TaxProvider` — and from nowhere else. `Money`, a
 *      snapshot, a `PaymentWebhookEvent` are descriptions of data the ledger
 *      records; a type-only import is erased at compile time and creates no
 *      runtime edge. "Type-only" means `import type …`, `export type … from`,
 *      or an import whose every specifier is `type X`. One value specifier
 *      makes the whole statement a value import.
 *   3. Type-only imports from an ADAPTER, the fake, the registry, the payout
 *      seam, readiness or the older `PayoutProvider` are still refused: nothing
 *      a ledger records is shaped by which provider is plugged in, so there is
 *      no type there it could need. (`creatorPayoutProviderBoundary.test.ts`
 *      PV3 already forbids the creator ledger any mention of PayoutProvider.)
 *   4. `lib/paymentsMode` is NOT a provider. It is the sandbox guard: pure
 *      functions over an env object, no I/O, no provider. A ledger may import
 *      it — to refuse to book a livemode entry, for instance — and this pin
 *      does not flag it.
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

/** Modules that DEFINE the contract's data types. Value imports refused; type-only imports allowed (rule 2). */
const CONTRACT_MODULES = ["services/payments/PaymentProvider", "services/payments/TaxProvider"] as const;

/**
 * Modules that ARE a provider, a provider's registry, or its wiring. No import
 * of any kind (rules 1 and 3). An adapter added later (PAY-T04's
 * StripePaymentProvider) is covered by the `*Provider` rule below and should
 * also be named here.
 */
const PROVIDER_MODULES = [
  "services/payments/FakePaymentProvider",
  "services/payments/providerRegistry",
  "services/payments/payoutSeam",
  "services/payments/paymentWebhookSignature",
  "services/payments/readiness",
  "services/creators/PayoutProvider",
] as const;

/** Third-party payment SDKs a ledger must never reach for, even for a type. */
const PROVIDER_PACKAGES = /^(stripe|@stripe\/|paypal|@paypal\/|adyen|@adyen\/|braintree|square)/;

interface FoundImport {
  specifier: string;
  /** Erased at compile time: `import type`, `export type … from`, or every specifier marked `type`. */
  typeOnly: boolean;
}

/** Is an import clause made only of `type` specifiers? `{ type A, type B }` yes; `{ type A, b }`, `x`, `* as n` no. */
function clauseIsTypeOnly(clause: string): boolean {
  const m = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!m) return false;
  const specifiers = (m[1] as string).split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  return specifiers.length > 0 && specifiers.every((x) => /^type\s+\S/.test(x));
}

/** Every module a source file names: static, type-only, side-effect, re-export, dynamic import and require. */
function findImports(source: string): FoundImport[] {
  const found: FoundImport[] = [];
  for (const m of source.matchAll(/\b(import|export)\s+(type\s+)?([^'"();]*?)\s*\bfrom\s*["']([^"']+)["']/g)) {
    found.push({ specifier: m[4] as string, typeOnly: m[2] !== undefined || clauseIsTypeOnly(m[3] as string) });
  }
  for (const m of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) found.push({ specifier: m[1] as string, typeOnly: false });
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier: m[1] as string, typeOnly: false });
  for (const m of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier: m[1] as string, typeOnly: false });
  return found;
}

/** The imports of `source` (living at src-relative `file`) that the rule refuses. Empty means clean. */
function providerImports(file: string, source: string): string[] {
  const offending: string[] = [];
  for (const { specifier, typeOnly } of findImports(source)) {
    if (!specifier.startsWith(".")) {
      if (PROVIDER_PACKAGES.test(specifier)) offending.push(specifier);
      continue;
    }
    const resolved = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.(js|ts|mjs|cjs)$/, "");
    if ((CONTRACT_MODULES as readonly string[]).includes(resolved)) {
      if (!typeOnly) offending.push(specifier);
      continue;
    }
    const isProvider =
      (PROVIDER_MODULES as readonly string[]).includes(resolved) ||
      (resolved.startsWith("services/payments/") && /Provider$/.test(posix.basename(resolved)));
    if (isProvider) offending.push(specifier);
  }
  return offending;
}

/** Ledger modules that MUST exist, and ones named by path that are scanned when they are present. */
const LEDGERS_REQUIRED = ["lib/rentBuddyEarningsLedger.ts", "lib/creatorLedgerEntries.ts"] as const;
const LEDGERS_WHEN_PRESENT = ["lib/rentBuddyLedgerPosting.ts", "services/payments/PaymentLedger.ts"] as const;

function ledgerModules(): { scanned: string[]; absent: string[] } {
  for (const f of LEDGERS_REQUIRED) assert.ok(existsSync(join(SRC, f)), `${f} is a ledger module this pin names; it has moved`);
  const named = LEDGERS_WHEN_PRESENT.filter((f) => existsSync(join(SRC, f)));
  const byName = readdirSync(join(SRC, "services/payments")).filter((f) => /^PaymentLedger.*\.ts$/.test(f)).map((f) => `services/payments/${f}`);
  return {
    scanned: [...new Set([...LEDGERS_REQUIRED, ...named, ...byName])].sort(),
    absent: LEDGERS_WHEN_PRESENT.filter((f) => !named.includes(f)),
  };
}

describe("PA1 — no ledger module imports a provider", () => {
  it("every ledger module that exists is free of provider value-imports, provider-wiring imports and payment SDKs", (t) => {
    const { scanned, absent } = ledgerModules();
    assert.ok(scanned.length >= 2, `scanned ${scanned.length} files`);
    for (const f of scanned) {
      const source = readFileSync(join(SRC, f), "utf8");
      assert.deepEqual(providerImports(f, source), [], `${f} imports a payment provider; the ledger must not know one exists`);
      assert.ok(!/\bfetch\s*\(|from\s+["']node:(https?|net|tls)["']/.test(source), `${f} reaches the network`);
    }
    t.diagnostic(`scanned: ${scanned.join(", ")}`);
    if (absent.length > 0) t.diagnostic(`not in this tree yet (scanned once merged): ${absent.join(", ")}`);
  });

  it("the modules named by path are named exactly: a rename of a ledger file must be noticed here", () => {
    assert.deepEqual([...LEDGERS_REQUIRED], ["lib/rentBuddyEarningsLedger.ts", "lib/creatorLedgerEntries.ts"]);
    assert.deepEqual([...LEDGERS_WHEN_PRESENT], ["lib/rentBuddyLedgerPosting.ts", "services/payments/PaymentLedger.ts"]);
    // A file that is present is scanned, whichever list it came from.
    const { scanned, absent } = ledgerModules();
    for (const f of LEDGERS_WHEN_PRESENT) assert.equal(scanned.includes(f), !absent.includes(f), f);
  });
});

describe("PA2 — the pin can fail", () => {
  const ledgerAt = "services/payments/PaymentLedger.ts";
  const specFor = (mod: string, from = ledgerAt): string => {
    const relative = posix.relative(posix.dirname(from), mod);
    return `${relative.startsWith(".") ? relative : `./${relative}`}.js`;
  };
  const VALUE_FORMS = (spec: string): string[] => [
    `import { x } from "${spec}";`,
    `import x from "${spec}";`,
    `import x, { type Y } from '${spec}';`,
    `import { type X, y } from "${spec}";`,
    `import * as p from "${spec}";`,
    `import "${spec}";`,
    `export { x } from "${spec}";`,
    `export * from "${spec}";`,
    `const p = await import("${spec}");`,
    `const p = require("${spec}");`,
    `import {\n  a,\n  b,\n} from "${spec}";`,
  ];
  const TYPE_FORMS = (spec: string): string[] => [
    `import type { X } from "${spec}";`,
    `import type X from "${spec}";`,
    `import type * as P from "${spec}";`,
    `import { type X } from "${spec}";`,
    `import { type X, type Y } from "${spec}";`,
    `import {\n  type X,\n  type Y,\n} from "${spec}";`,
    `export type { X } from "${spec}";`,
    `export type * from "${spec}";`,
  ];

  it("rule 1: a value import of any provider or contract module is flagged, in every form", () => {
    for (const mod of [...PROVIDER_MODULES, ...CONTRACT_MODULES]) {
      const spec = specFor(mod);
      for (const form of VALUE_FORMS(spec)) assert.deepEqual(providerImports(ledgerAt, form), [spec], `${mod}: ${form}`);
    }
  });

  it("rule 2: a type-only import of the contract's data types is allowed — from PaymentProvider and TaxProvider only", () => {
    for (const mod of CONTRACT_MODULES) {
      const spec = specFor(mod);
      for (const form of TYPE_FORMS(spec)) assert.deepEqual(providerImports(ledgerAt, form), [], `${mod}: ${form}`);
    }
    // …and from lib/, where the two older ledgers live.
    assert.deepEqual(providerImports("lib/rentBuddyLedgerPosting.ts", `import type { Money } from "../services/payments/PaymentProvider.js";`), []);
    assert.deepEqual(providerImports("lib/rentBuddyLedgerPosting.ts", `import { isMoney, type Money } from "../services/payments/PaymentProvider.js";`), ["../services/payments/PaymentProvider.js"]);
  });

  it("rule 3: even a type-only import of an adapter, the fake, the registry, the seam, readiness or PayoutProvider is flagged", () => {
    for (const mod of PROVIDER_MODULES) {
      const spec = specFor(mod);
      for (const form of TYPE_FORMS(spec)) assert.deepEqual(providerImports(ledgerAt, form), [spec], `${mod}: ${form}`);
    }
    assert.deepEqual(providerImports(ledgerAt, `import type { S } from "./StripePaymentProvider.js";`), ["./StripePaymentProvider.js"], "a future adapter, by name");
    assert.deepEqual(providerImports(ledgerAt, `import { s } from "./StripePaymentProvider.js";`), ["./StripePaymentProvider.js"]);
    assert.deepEqual(providerImports("lib/creatorLedgerEntries.ts", `import type { PayoutProvider } from "../services/creators/PayoutProvider.js";`), ["../services/creators/PayoutProvider.js"]);
    assert.deepEqual(providerImports("lib/rentBuddyEarningsLedger.ts", `import { getPaymentProvider } from "../services/payments/providerRegistry.js";`), ["../services/payments/providerRegistry.js"]);
  });

  it("a payment SDK is flagged even as a type", () => {
    assert.deepEqual(providerImports(ledgerAt, `import Stripe from "stripe";`), ["stripe"]);
    assert.deepEqual(providerImports(ledgerAt, `import type Stripe from "stripe";`), ["stripe"]);
    assert.deepEqual(providerImports(ledgerAt, `import { loadStripe } from "@stripe/stripe-js";`), ["@stripe/stripe-js"]);
  });

  it("rule 4: lib/paymentsMode is the sandbox guard, not a provider — a ledger may import it", () => {
    for (const form of [...VALUE_FORMS("../../lib/paymentsMode.js"), ...TYPE_FORMS("../../lib/paymentsMode.js")]) {
      assert.deepEqual(providerImports(ledgerAt, form), [], form);
    }
    assert.deepEqual(providerImports("lib/creatorLedgerEntries.ts", `import { liveAllowed } from "./paymentsMode.js";`), []);
  });

  it("passes a clean ledger, a look-alike name, and a word in a comment", () => {
    const clean = [
      `import { isFlagEnabled } from "../../lib/featureFlags.js";`,
      `import { toMinor } from "../../lib/creatorLedgerEntries.js";`,
      `import { readiness } from "../identityVerification/readiness.js";`,
      `import { x } from "./PaymentLedgerRows.js";`,
      `import { fold } from "./paymentEventFold.js";`,
      `// the provider (see ./PaymentProvider.js) is deliberately not imported here`,
      `const provider = "none"; const s = "import x from PaymentProvider";`,
    ].join("\n");
    assert.deepEqual(providerImports(ledgerAt, clean), []);
  });

  it("the type-only test itself: one value specifier makes the whole statement a value import", () => {
    assert.equal(clauseIsTypeOnly("{ type A }"), true);
    assert.equal(clauseIsTypeOnly("{ type A, type B }"), true);
    assert.equal(clauseIsTypeOnly("{\n  type A,\n  type B,\n}"), true);
    for (const clause of ["{ type A, b }", "{ a }", "x", "x, { type A }", "* as n", "{}", "{ typeA }", ""]) assert.equal(clauseIsTypeOnly(clause), false, clause);
    assert.deepEqual(findImports(`import type { A } from "./a.js";\nimport { b } from "./b.js";\nexport type { C } from "./c.js";`), [
      { specifier: "./a.js", typeOnly: true },
      { specifier: "./b.js", typeOnly: false },
      { specifier: "./c.js", typeOnly: true },
    ]);
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
      for (const { specifier } of findImports(source)) {
        assert.ok(specifier.startsWith(".") || specifier === "node:crypto", `${f} imports ${specifier}; these modules import repo files and node:crypto only`);
      }
      assert.ok(!/\bfetch\s*\(/.test(source), `${f} calls fetch`);
      assert.ok(!/\bfrom\(\s*["'][a-z_]+["']\s*\)|\.rpc\(/.test(source), `${f} talks to the database`);
    }
  });

  it("no provider module imports a ledger", () => {
    for (const f of OWN) {
      const source = readFileSync(join(SRC, f), "utf8");
      for (const { specifier } of findImports(source)) {
        assert.ok(!/Ledger/i.test(specifier), `${f} imports ${specifier}; a provider must not know the ledger either`);
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
    assert.deepEqual(findImports(source), []);
    for (const name of ["NONE_PAYOUT_PROVIDER", "NONE_PROVIDER_ID", "resolvePayoutProvider", "PayoutProvider"]) {
      assert.match(source, new RegExp(`export (const|function|interface) ${name}\\b`), name);
    }
    const seam = readFileSync(join(SRC, "services/payments/payoutSeam.ts"), "utf8");
    assert.ok(findImports(seam).some((i) => i.specifier === "../creators/PayoutProvider.js"), "the seam is built ON the old module, not beside it");
  });
});
