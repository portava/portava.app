/**
 * e2eeThread — the orchestration callers actually use.
 *
 * threadCrypto.ts holds the decisions; this file holds the sequences, so no
 * screen has to know the ordering rules. Every step that can be got wrong is
 * either impossible to reach out of order or fails loudly.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * Welcome BEFORE is_e2ee, never the reverse. The server enforces it too
 * (POST /threads/:id/e2ee refuses without a Welcome in the thread), so this is
 * belt and braces rather than the only guard — deliberately, because a thread
 * marked encrypted with no deliverable Welcome can never be read by anyone.
 *
 * ── ITEM 5 IS UNPROVEN ──────────────────────────────────────────────────────
 * None of this has crossed the uniffi FFI boundary. The Rust compiles and its
 * own tests pass; the Swift/Kotlin bindings generate. Neither has been compiled
 * or executed, because that needs Xcode and the Android NDK. On a device where
 * the native module is absent, `isNative()` is false and every path here
 * degrades to "not encrypted" — plaintext threads keep working, E2EE simply
 * never turns on. That is the safe direction, and it is what would happen
 * today.
 */

import {
  buildOutgoingPayload,
  decryptIncoming,
  establishE2ee,
  joinFromWelcomeIfNeeded,
  E2EE_WELCOME_SUBTYPE,
  E2eeSendBlockedError,
  type CryptoPort,
  type DecryptedMessage,
  type IncomingMessageLike,
  type NegotiationResult,
} from './threadCrypto.ts';
import { realCryptoPort } from './realPort.ts';
import {
  consumePeerKeyPackage,
  markThreadE2ee,
  publishKeyPackages,
  sendMessage,
} from '../../services/messaging.ts';

export { E2eeSendBlockedError, buildOutgoingPayload };
export type { DecryptedMessage, NegotiationResult };

/**
 * Turn on E2EE for a NEW 1:1 thread.
 *
 * Returns a NegotiationResult rather than throwing: a failure here leaves the
 * thread plaintext and working, which is a legitimate outcome. It is the SEND
 * path that must never degrade, not the negotiation.
 *
 * Existing threads are never migrated — this is only called at creation.
 */
export async function enableE2eeForNewThread(
  threadId: string,
  myUserId: string,
  peerUserId: string,
  port: CryptoPort = realCryptoPort,
): Promise<NegotiationResult> {
  return establishE2ee(port, threadId, myUserId, peerUserId, {
    consumeKeyPackage: async (peer) => {
      const res = await consumePeerKeyPackage(peer);
      return res.ok && res.data?.keyPackageB64 ? res.data.keyPackageB64 : null;
    },

    // The Welcome rides as a plaintext system message. This MUST succeed
    // before the thread is flagged; the server checks the same thing.
    sendWelcome: async (tid, welcomeB64) => {
      const res = await sendMessage(tid, welcomeB64, {
        msgType: 'system',
        subtype: E2EE_WELCOME_SUBTYPE,
        // Explicitly NOT isE2ee: the thread is still plaintext at this point,
        // and must be, or the server would reject this very message.
      });
      return res.ok;
    },

    markThreadE2ee: async (tid) => (await markThreadE2ee(tid)).ok,
  });
}

/**
 * Prepare a fetched message list for rendering.
 *
 * Joins from a Welcome first if this device has not yet joined, then decrypts.
 * Order matters: decrypting before joining would mark every message
 * undecryptable on the recipient's very first fetch.
 *
 * Never throws. A message this device cannot read comes back with
 * `failed: true` so the UI can say so, rather than being dropped — a silent gap
 * in a conversation reads as "nothing was said".
 */
export async function hydrateIncomingMessages(
  threadId: string,
  messages: IncomingMessageLike[],
  port: CryptoPort = realCryptoPort,
): Promise<DecryptedMessage[]> {
  await joinFromWelcomeIfNeeded(port, threadId, messages);

  const out: DecryptedMessage[] = [];
  for (const msg of messages) {
    // The Welcome is protocol plumbing, not conversation. Drop it from the
    // rendered list rather than showing users a wall of base64.
    if (msg.msgType === 'system' && msg.subtype === E2EE_WELCOME_SUBTYPE) continue;
    out.push(await decryptIncoming(port, threadId, msg));
  }
  return out;
}

/**
 * Publish a KeyPackage so other users can start an E2EE thread with this
 * device, and retain the private material the resulting Welcome needs.
 *
 * The pending state is stored BEFORE publishing. If the order were reversed a
 * peer could consume the KeyPackage and send a Welcome this device has no key
 * for — an unreadable thread, the exact failure this whole sequence exists to
 * avoid. Storing first can at worst leave an unused pending state, which is
 * harmless.
 */
export async function publishKeyPackage(
  userId: string,
  deviceId: string,
  port: CryptoPort = realCryptoPort,
): Promise<boolean> {
  if (!port.isNative()) return false;

  let ExpoOpenmls: { generateKeyPackage?: unknown } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ExpoOpenmls = require('expo-openmls');
  } catch {
    return false;
  }
  const gen = (ExpoOpenmls as { generateKeyPackage?: (...a: unknown[]) => Promise<unknown> })
    ?.generateKeyPackage;
  if (typeof gen !== 'function') return false;

  const keys = await port.getDeviceSigningKeys();
  if (!keys) return false;

  type KpResult = { keyPackageB64?: string; pendingStateB64?: string };
  let result: KpResult | null = null;
  try {
    result = (await gen(userId, keys.priv, keys.pub)) as KpResult | null;
  } catch {
    return false;
  }
  const keyPackageB64 = result?.keyPackageB64;
  const pendingStateB64 = result?.pendingStateB64;
  if (!keyPackageB64 || !pendingStateB64) return false;

  await port.setPendingKeyPackageState(pendingStateB64);

  const res = await publishKeyPackages(deviceId, [keyPackageB64]);
  return res.ok;
}
