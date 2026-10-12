/**
 * deviceTrust — the ONLY writer of `devices.trust_state` (Telegraph §30A.7,
 * census-telegraph T399; owner ruling OD-1012-DEV-1).
 *
 *   "Devices default to unverified. Only server-validated evidence may promote
 *    `trust_state`; never accept a client's self-declaration as proof."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS SCAFFOLDING. DEV-1's PROMOTION IS NOT IMPLEMENTED.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Which server-validated evidence promotes a device is an OPEN owner decision
 * (owner-decisions-20261012 Part 3): any platform attestation provider (App
 * Attest, Play Integrity, ...) is a new integration that needs its own
 * decision. No verifier is registered anywhere in this tree, so
 * `promoteDeviceTrust` refuses every call with `no_verifier_registered` and no
 * device can become `verified`. What exists:
 *
 *   - the fail-closed default (3743: NOT NULL DEFAULT 'unverified', CHECK);
 *   - this seam: a verifier interface, a registry that is empty in production,
 *     evidence that only a registered verifier can mint (a plain object — e.g.
 *     anything parsed from a request — is refused), and one update site that
 *     writes the CONSTANT 'verified' / 'unverified', never a value it was given;
 *   - demotion to 'unverified' (used by device revocation when the registry row
 *     has to be kept for a retry).
 *
 * AUDIT. No device-trust audit table exists. A promotion therefore also needs a
 * registered audit sink (`DeviceTrustAuditSink`), written BEFORE the state
 * changes; with none registered the promotion is refused (`audit_unavailable`).
 * Choosing the provider includes choosing where its evidence is recorded.
 *
 * Guarded by src/test/deviceTrustSeam.test.ts: no other file may write
 * trust_state, every `devices` write must be a literal-keyed object (no spread,
 * no request value), and nothing outside tests may register a verifier.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type DeviceTrustState = "unverified" | "verified";

/** Evidence older than this is stale: a verifier's answer is about NOW. */
export const DEVICE_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Evidence a registered server-side verifier produced for one device. Only
 * `collectDeviceEvidence` creates these; `promoteDeviceTrust` accepts an object
 * only if it is one of those exact instances (identity, not shape).
 */
export interface ServerValidatedDeviceEvidence {
  readonly verifierId: string;
  /** The evidence kind the verifier attests (e.g. a provider name) — what the audit records. */
  readonly kind: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly verifiedAtMs: number;
}

/** What a verifier answers. It talks to its provider SERVER-SIDE; it is never handed client claims as proof. */
export type DeviceVerifierResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface DeviceEvidenceVerifier {
  readonly id: string;
  readonly kind: string;
  verify(sc: SupabaseClient, subject: { readonly userId: string; readonly deviceId: string }): Promise<DeviceVerifierResult>;
}

export interface DeviceTrustAuditSink {
  /** Must durably record the promotion; return false (or throw) if it could not. */
  record(entry: {
    readonly userId: string;
    readonly deviceId: string;
    readonly verifierId: string;
    readonly kind: string;
    readonly verifiedAtMs: number;
  }): Promise<boolean>;
}

export type DeviceTrustRefusal =
  | "no_verifier_registered"
  | "verifier_not_registered"
  | "verifier_rejected"
  | "verifier_error"
  | "evidence_not_server_validated"
  | "evidence_device_mismatch"
  | "evidence_stale"
  | "audit_unavailable"
  | "device_not_found"
  | "trust_column_absent"
  | "write_failed";

export type CollectEvidenceResult =
  | { readonly ok: true; readonly evidence: ServerValidatedDeviceEvidence }
  | { readonly ok: false; readonly refusal: DeviceTrustRefusal; readonly detail?: string };

export type PromoteResult =
  | { readonly ok: true; readonly trustState: "verified"; readonly kind: string }
  | { readonly ok: false; readonly refusal: DeviceTrustRefusal };

// ── Registry (EMPTY in production — no provider has been decided) ────────────

const verifiers = new Map<string, DeviceEvidenceVerifier>();
let auditSink: DeviceTrustAuditSink | null = null;
/** Every evidence object a registered verifier minted. Identity, not shape. */
const minted = new WeakSet<object>();

/**
 * Register a server-side verifier. Nothing outside tests calls this: wiring one
 * in is the owner decision DEV-1 Part 3 (which evidence / provider).
 */
export function registerDeviceEvidenceVerifier(v: DeviceEvidenceVerifier): void {
  if (!v || typeof v.id !== "string" || !v.id || typeof v.kind !== "string" || !v.kind || typeof v.verify !== "function") {
    throw new TypeError("registerDeviceEvidenceVerifier: a verifier needs an id, a kind and verify()");
  }
  verifiers.set(v.id, v);
}

export function registerDeviceTrustAuditSink(sink: DeviceTrustAuditSink | null): void {
  auditSink = sink;
}

export function registeredDeviceVerifierIds(): string[] {
  return [...verifiers.keys()];
}

/** Test-only: forget every verifier and the audit sink. */
export function _resetDeviceTrustRegistry(): void {
  verifiers.clear();
  auditSink = null;
}

// ── Evidence ──────────────────────────────────────────────────────────────────

/**
 * Ask the registered verifier `verifierId` about this device. The only way to
 * obtain a ServerValidatedDeviceEvidence. Takes ids only — no client payload.
 */
export async function collectDeviceEvidence(
  sc: SupabaseClient,
  verifierId: string,
  subject: { readonly userId: string; readonly deviceId: string },
  nowMs: number = Date.now(),
): Promise<CollectEvidenceResult> {
  if (verifiers.size === 0) return { ok: false, refusal: "no_verifier_registered" };
  const v = verifiers.get(verifierId);
  if (!v) return { ok: false, refusal: "verifier_not_registered" };
  let r: DeviceVerifierResult;
  try {
    r = await v.verify(sc, { userId: subject.userId, deviceId: subject.deviceId });
  } catch (err) {
    return { ok: false, refusal: "verifier_error", detail: String((err as Error)?.message ?? err) };
  }
  if (!r || r.ok !== true) return { ok: false, refusal: "verifier_rejected", detail: r && r.ok === false ? r.reason : undefined };
  const evidence: ServerValidatedDeviceEvidence = Object.freeze({
    verifierId: v.id,
    kind: v.kind,
    userId: subject.userId,
    deviceId: subject.deviceId,
    verifiedAtMs: nowMs,
  });
  minted.add(evidence);
  return { ok: true, evidence };
}

// ── The only writes of trust_state ────────────────────────────────────────────

function isMissingTrustColumn(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  const code = String(e.code ?? "");
  const msg = String(e.message ?? "");
  return code === "42703" || code === "PGRST204" || (/trust_state/i.test(msg) && /does not exist|could not find/i.test(msg));
}

/**
 * Promote one device to `verified`. Refuses (never throws) unless ALL hold:
 * a verifier is registered; the evidence is an instance a registered verifier
 * minted, for this device, within DEVICE_EVIDENCE_MAX_AGE_MS; an audit sink is
 * registered and recorded the evidence kind; the row exists for the evidence's
 * user. The written value is the constant 'verified'.
 */
export async function promoteDeviceTrust(
  sc: SupabaseClient,
  deviceId: string,
  evidence: ServerValidatedDeviceEvidence,
  nowMs: number = Date.now(),
): Promise<PromoteResult> {
  if (verifiers.size === 0) return { ok: false, refusal: "no_verifier_registered" };
  if (!evidence || typeof evidence !== "object" || !minted.has(evidence)) {
    return { ok: false, refusal: "evidence_not_server_validated" };
  }
  if (!verifiers.has(evidence.verifierId)) return { ok: false, refusal: "verifier_not_registered" };
  if (evidence.deviceId !== deviceId) return { ok: false, refusal: "evidence_device_mismatch" };
  if (!(nowMs - evidence.verifiedAtMs >= 0 && nowMs - evidence.verifiedAtMs <= DEVICE_EVIDENCE_MAX_AGE_MS)) {
    return { ok: false, refusal: "evidence_stale" };
  }
  if (!auditSink) return { ok: false, refusal: "audit_unavailable" };
  let audited = false;
  try {
    audited = (await auditSink.record({
      userId: evidence.userId,
      deviceId,
      verifierId: evidence.verifierId,
      kind: evidence.kind,
      verifiedAtMs: evidence.verifiedAtMs,
    })) === true;
  } catch {
    audited = false;
  }
  if (!audited) return { ok: false, refusal: "audit_unavailable" };

  const { data, error } = await sc
    .from("devices")
    .update({ trust_state: "verified" })
    .eq("id", deviceId)
    .eq("user_id", evidence.userId)
    .select("id");
  if (error) return { ok: false, refusal: isMissingTrustColumn(error) ? "trust_column_absent" : "write_failed" };
  if (!Array.isArray(data) || data.length === 0) return { ok: false, refusal: "device_not_found" };
  return { ok: true, trustState: "verified", kind: evidence.kind };
}

/**
 * Demote one device to `unverified` (revocation). Needs no evidence: lowering
 * trust is always safe. A database without the 3743 column has nothing to demote.
 */
export async function demoteDeviceTrust(
  sc: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<"done" | "column_absent" | "failed"> {
  const { error } = await sc
    .from("devices")
    .update({ trust_state: "unverified" })
    .eq("id", deviceId)
    .eq("user_id", userId);
  if (!error) return "done";
  return isMissingTrustColumn(error) ? "column_absent" : "failed";
}
