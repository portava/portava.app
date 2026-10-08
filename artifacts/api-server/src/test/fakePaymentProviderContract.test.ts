/**
 * The deterministic fake runs the SAME contract suite the Stripe Connect
 * adapter runs (test/helpers/paymentProviderContractSuite.ts), so "passes the
 * contract the fake passes" is one suite, not two similar ones.
 *
 * Run: node --import tsx/esm --test src/test/fakePaymentProviderContract.test.ts
 */
import { createFakePaymentProvider } from "../services/payments/FakePaymentProvider.js";
import { LOCAL_ENV } from "./helpers/paymentFixtures.js";
import { runPaymentProviderContract, type ContractHarness } from "./helpers/paymentProviderContractSuite.js";

runPaymentProviderContract("fake", (): ContractHarness => {
  const fake = createFakePaymentProvider({ env: LOCAL_ENV });
  return {
    provider: fake,
    market: { country: "US", currency: "USD" },
    async newRecipient(key, country = "US") {
      const r = await fake.createRecipient({
        idempotencyKey: key, profileId: `party-${key}`, country, entityType: "individual", settlementCurrency: "USD",
        returnUrl: "app://ok", refreshUrl: "app://again",
      });
      if (r.status !== "requires_action") throw new Error(`fake createRecipient: ${JSON.stringify(r)}`);
      return r.value.recipientRef;
    },
    verify: (ref) => { fake.control.setRecipientOnboarding(ref, "verified"); },
    pending: (ref) => { fake.control.setRecipientOnboarding(ref, "pending_verification"); },
    reject: (ref) => { fake.control.setRecipientOnboarding(ref, "rejected"); },
    declineNextConfirm: () => fake.control.script.declineNextConfirm("insufficient_funds"),
    requireActionNextConfirm: () => fake.control.script.requireActionOnNextConfirm(),
    failNext: (op) => fake.control.script.failNextOperation(op, "provider_unreachable"),
    deliveries: (o = {}) => fake.control.webhooks.deliver(o.livemode ? { livemode: true } : {}),
    sign: (raw, endpoint) => fake.control.webhooks.signRawBody(raw, endpoint),
  };
});
