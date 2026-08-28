/**
 * Presence Network — transport abstraction (spec §7).
 *
 * INTERFACE ONLY. No implementation, no radio code, no feature logic.
 *
 * The spec's rule is that the Presence Network must not be coupled to Bluetooth:
 * "future transports should be insertable without changing feature-level logic",
 * and §67 explicitly forbids "separate BLE engines for Bump and Crowd Locate".
 * The way to make that structural rather than aspirational is for every feature
 * to depend on THIS interface and never on a concrete radio — so a transport can
 * be added, swapped, or absent without a feature noticing.
 *
 * The capability model matters as much as the interface. On the current Portava
 * stack (verified 2026-08-28) background location ships and BLE does not exist at
 * all, so any implementation must be able to say truthfully what it cannot do,
 * and callers must branch on that rather than assume a radio.
 */
import type {
  PresenceCapabilities,
  PresenceEvidenceType,
  GeoPoint,
} from "./types.js";

/** Cleanup handle returned by subscriptions. */
export type Unsubscribe = () => void;

/**
 * A raw report as it leaves a transport, BEFORE the ledger stamps it.
 * Deliberately not `PresenceObservation`: a transport does not know the session
 * expiry or the received-at clock — the ingest boundary supplies those. Keeping
 * the types distinct stops a transport from fabricating ledger fields.
 */
export interface RawPresenceObservation {
  /** Rotating ephemeral id of the subject (§6) — never a persistent user id. */
  subjectEphemeralId: string;
  /** Present when this device OBSERVED someone else (BLE/peer); null for self-reports. */
  observerEphemeralId?: string | null;
  source: PresenceEvidenceType;
  /** Device clock at observation. The ingest boundary is responsible for clamping. */
  observedAt: Date;
  point?: GeoPoint | null;
  accuracyM?: number | null;
  /**
   * Coarse proximity only. §14: RSSI is noisy, so a transport reports a BUCKET,
   * never a decimal metre reading it cannot justify.
   */
  proximity?: "very_close" | "nearby" | "within_area" | "weak" | null;
  headingDeg?: number | null;
  speedMps?: number | null;
  floor?: number | null;
  zoneId?: string | null;
  anchorId?: string | null;
}

export interface AdvertiseConfig {
  sessionId: string;
  /** The rotating id to broadcast. Rotation is the caller's responsibility (§6). */
  ephemeralId: string;
  /** Hard stop. A transport must not advertise indefinitely (§2.4). */
  expiresAt: Date;
}

export interface ScanConfig {
  sessionId: string;
  /** §47 adaptive scanning — the transport maps this to a duty cycle. */
  mode: "passive" | "normal" | "crowd" | "search" | "sos" | "low_battery";
  expiresAt: Date;
}

/**
 * The seam every presence feature depends on.
 *
 * Implementations to come (none written yet): ServerPresenceTransport,
 * BLEPresenceTransport, LocalPeerTransport, UWBPresenceTransport,
 * VenueAnchorTransport.
 */
export interface PresenceTransport {
  readonly id: string;

  /**
   * What this transport can actually do on THIS device, right now. Callers must
   * consult it rather than assuming — the honest answer on today's stack is that
   * every BLE capability is false.
   */
  capabilities(): PresenceTransportCapabilities;

  startAdvertising(config: AdvertiseConfig): Promise<void>;
  stopAdvertising(): Promise<void>;

  startScanning(config: ScanConfig): Promise<void>;
  stopScanning(): Promise<void>;

  onObservation(cb: (observation: RawPresenceObservation) => void): Unsubscribe;
}

/** Per-transport capabilities, plus the device-wide picture (§71). */
export interface PresenceTransportCapabilities extends PresenceCapabilities {
  /** False when the OS denied a permission the transport needs (§66). */
  permissionGranted: boolean;
  /** Human-readable reason the transport is unavailable, for §66 failure states. */
  unavailableReason?: string | null;
}

/**
 * Choose the transports worth starting for a device.
 *
 * Pure and total: given capabilities it returns which of the supplied transports
 * can contribute, so a caller never starts a radio the device lacks and never
 * silently does nothing without a reason. Returning the reasons alongside is
 * deliberate — §66 requires the product to explain what information remains
 * available when a capability is missing.
 */
export function selectUsableTransports(
  transports: readonly PresenceTransport[],
): { usable: PresenceTransport[]; unusable: Array<{ id: string; reason: string }> } {
  const usable: PresenceTransport[] = [];
  const unusable: Array<{ id: string; reason: string }> = [];

  for (const t of transports) {
    const c = t.capabilities();
    if (!c.permissionGranted) {
      unusable.push({ id: t.id, reason: c.unavailableReason ?? "permission not granted" });
      continue;
    }
    const canDoAnything =
      c.bleScan || c.bleAdvertise || c.backgroundLocation || c.localPeer || c.uwb;
    if (!canDoAnything) {
      unusable.push({ id: t.id, reason: c.unavailableReason ?? "no supported capability on this device" });
      continue;
    }
    usable.push(t);
  }
  return { usable, unusable };
}
