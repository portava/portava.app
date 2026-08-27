/**
 * D4 Intelligence Contributions consent — the server-authoritative gate.
 *
 * In-memory (fake client) proofs of the consent MODEL: default-off, granted state,
 * version stamping, withdrawal blocking, re-consent, per-actor isolation, and that
 * the version is server-set (a client cannot forge it). The DB-grant proof that
 * `authenticated` cannot write the table at all, and the writeObservation
 * enforcement, live in intelCapture.test.ts + the CI SQL verification.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasValidIntelConsent,
  getIntelConsentState,
  setIntelConsent,
  INTEL_CONSENT_DISCLOSURE_VERSION,
} from "../lib/intelConsent.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A fake keyed by user_id, supporting select/eq/maybeSingle + upsert(onConflict). */
function consentDb() {
  const rows = new Map<string, any>();
  return {
    _rows: rows,
    from(_t: string) {
      let uid: string | null = null;
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { if (c === "user_id") uid = v; return b; },
        upsert(r: any) {
          const cur = rows.get(r.user_id) ?? {};
          rows.set(r.user_id, { ...cur, ...r }); // ON CONFLICT DO UPDATE SET <patch only>
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle() { return Promise.resolve({ data: uid ? rows.get(uid) ?? null : null, error: null }); },
      };
      return b;
    },
  };
}

describe("D4 consent — model", () => {
  it("defaults to NO valid consent when no row exists (fail-closed)", async () => {
    const db = consentDb();
    assert.equal(await hasValidIntelConsent(db as any, A), false);
    const st = await getIntelConsentState(db as any, A);
    assert.equal(st.enabled, false);
    assert.equal(st.consentVersion, null);
    assert.equal(st.currentDisclosureVersion, INTEL_CONSENT_DISCLOSURE_VERSION);
  });

  it("an explicit grant records valid, versioned consent (server-stamped)", async () => {
    const db = consentDb();
    const out = await setIntelConsent(db as any, A, true);
    assert.equal(out.ok, true);
    assert.equal(await hasValidIntelConsent(db as any, A), true);
    const st = await getIntelConsentState(db as any, A);
    assert.equal(st.enabled, true);
    // Version + consent instant are recorded, and the version is the SERVER constant,
    // not anything the caller supplied (the caller passes only `enabled`).
    assert.equal(st.consentVersion, INTEL_CONSENT_DISCLOSURE_VERSION);
    assert.ok(st.consentedAt, "consented_at recorded");
    assert.equal(st.withdrawnAt, null);
  });

  it("withdrawal immediately blocks future capture and records the withdrawal instant", async () => {
    const db = consentDb();
    await setIntelConsent(db as any, A, true);
    await setIntelConsent(db as any, A, false);
    assert.equal(await hasValidIntelConsent(db as any, A), false);
    const st = await getIntelConsentState(db as any, A);
    assert.equal(st.enabled, false);
    assert.ok(st.withdrawnAt, "withdrawn_at recorded");
    // The prior consent evidence is preserved as an audit trail.
    assert.equal(st.consentVersion, INTEL_CONSENT_DISCLOSURE_VERSION);
    assert.ok(st.consentedAt);
  });

  it("re-consent after withdrawal restores valid consent and clears the withdrawal", async () => {
    const db = consentDb();
    await setIntelConsent(db as any, A, true);
    await setIntelConsent(db as any, A, false);
    await setIntelConsent(db as any, A, true);
    assert.equal(await hasValidIntelConsent(db as any, A), true);
    const st = await getIntelConsentState(db as any, A);
    assert.equal(st.enabled, true);
    assert.equal(st.withdrawnAt, null);
  });

  it("one actor's consent never authorizes another actor", async () => {
    const db = consentDb();
    await setIntelConsent(db as any, A, true);
    assert.equal(await hasValidIntelConsent(db as any, A), true);
    assert.equal(await hasValidIntelConsent(db as any, B), false, "B never consented");
  });

  it("consent to some OTHER purpose does not satisfy intel consent (table-specific)", async () => {
    // hasValidIntelConsent reads ONLY intel_contribution_consent. An actor with no
    // row here is unconsented regardless of any other purpose's opt-in.
    const db = consentDb();
    assert.equal(await hasValidIntelConsent(db as any, A), false);
  });

  it("fails closed on a read error", async () => {
    const throwing = { from() { return { select() { return this; }, eq() { return this; }, maybeSingle() { throw new Error("boom"); } }; } };
    assert.equal(await hasValidIntelConsent(throwing as any, A), false);
  });
});
