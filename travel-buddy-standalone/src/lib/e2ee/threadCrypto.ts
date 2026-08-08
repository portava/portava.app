/**
 * threadCrypto — the E2EE seam for Telegraph 1:1 DMs.
 *
 * Everything that decides "is this thread encrypted, and what do we put on the
 * wire" lives here so the rule below has exactly one home.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * An E2EE thread NEVER falls back to plaintext. If encryption cannot happen —
 * no native module, no group state, a decrypt failure, anything — the send
 * FAILS and the user is told. A message that quietly goes out in the clear on
 * a thread the UI has marked encrypted is worse than any error, because the
 * user has already made a trust decision based on that lock icon.
 *
 * `encryptForSend` therefore has no fallback branch and no `catch` that
 * returns plaintext. It returns ciphertext or it throws.
 *
 * ── WELCOME TRANSPORT ───────────────────────────────────────────────────────
 * There is no Welcome column, table or endpoint on the server, and adding one
 * is a schema change. The Welcome instead rides as an ordinary system message
 * (`msgType: 'system'`, `subtype: 'e2ee_welcome'`, body = the Welcome), sent
 * BEFORE the thread is flipped to `is_e2ee` — the server rejects a plaintext
 * body on an E2EE thread, so ordering matters.
 *
 * That is safe: an MLS Welcome is encrypted to the recipient's KeyPackage, so
 * it is not secret. The server can see that a Welcome happened — which it can
 * see anyway from `is_e2ee` — but not its contents.
 *
 * ── PENDING KEYPACKAGE STATE — decision ─────────────────────────────────────
 * `generateKeyPackage` returns `pendingStateB64`, the provider snapshot holding
 * the KeyPackage's private material. The Welcome is encrypted to it, so
 * without it a join is impossible.
 *
 * Decision: store it in SecureStore under ONE key, replaced whenever a new
 * KeyPackage is published, i.e. exactly one KeyPackage outstanding per device.
 *
 * Why: the alternative is accumulating many KeyPackages' private material in
 * one growing snapshot, which needs the Rust side to take a prior state and
 * merge — more moving parts in the layer that has already proven fragile.
 * Single-device (decision B1) means there is one consumer of this key, and the
 * cost of getting it wrong is silent undecryptable threads.
 *
 * The cost of the choice, stated rather than hidden: the server pool is
 * effectively size 1, so a second person trying to start an E2EE thread before
 * the pool is replenished gets `no_key_package` and the negotiation fails
 * VISIBLY. That is the correct direction to fail, but it is a real limitation
 * and the replenish-on-consume path is follow-up work.
 */

/**
 * The crypto operations this module needs, injected rather than imported.
 *
 * Injection is not ceremony here: it is what lets the failure paths below be
 * tested at all. mlsSession/secureStore pull in expo-modules-core, which is why
 * the E-0/E-1/E-2 suites sit in run-node-tests.mjs's exclude list and have
 * never run. A seam whose whole job is "never fall back to plaintext" has to be
 * exercisable.
 */
export interface CryptoPort {
  isNative(): boolean;
  hasGroupSession(threadId: string): Promise<boolean>;
  encryptForThread(threadId: string, plaintext: string): Promise<string | null>;
  decryptFromThread(threadId: string, ciphertextB64: string): Promise<string | null>;
  initGroupAsInitiator(
    threadId: string,
    userId: string,
    recipientKeyPackageB64: string,
  ): Promise<{ welcomeB64: string } | null>;
  initGroupAsRecipient(
    threadId: string,
    welcomeB64: string,
    pendingStateB64: string,
  ): Promise<boolean>;
  /** The device's Ed25519 signing pair, or null before crypto identity exists. */
  getDeviceSigningKeys(): Promise<{ priv: string; pub: string } | null>;
  getPendingKeyPackageState(): Promise<string | null>;
  setPendingKeyPackageState(stateB64: string): Promise<void>;
  clearPendingKeyPackageState(): Promise<void>;
}

/** Marks the system message that carries an MLS Welcome. */
export const E2EE_WELCOME_SUBTYPE = 'e2ee_welcome';

/** Raised when an encrypted thread cannot produce ciphertext. Never swallowed. */
export class E2eeSendBlockedError extends Error {
  readonly reason: E2eeBlockReason;
  constructor(reason: E2eeBlockReason, message: string) {
    super(message);
    this.name = 'E2eeSendBlockedError';
    this.reason = reason;
  }
}

export type E2eeBlockReason =
  /** Native module absent — Expo Go, or an EAS build without the Rust. */
  | 'no_native_module'
  /** No MLS group for this thread on this device (e.g. reinstall, or never joined). */
  | 'no_group_state'
  /** The module was present and refused. */
  | 'encrypt_failed';

export interface OutgoingPayload {
  body?: string;
  ciphertext?: string;
}

// ── Send path ───────────────────────────────────────────────────────────────

/**
 * Build the wire payload for a message.
 *
 * Plaintext threads get `{ body }` exactly as before — the non-E2EE path is
 * unchanged, which matters because every existing thread takes it.
 *
 * E2EE threads get `{ ciphertext }` or an exception. There is deliberately no
 * third outcome.
 */
export async function buildOutgoingPayload(
  port: CryptoPort,
  threadId: string,
  body: string,
  isE2ee: boolean,
): Promise<OutgoingPayload> {
  if (!isE2ee) return { body };

  if (!port.isNative()) {
    throw new E2eeSendBlockedError(
      'no_native_module',
      'This conversation is encrypted and this build cannot encrypt. Your message was not sent.',
    );
  }

  if (!(await port.hasGroupSession(threadId))) {
    throw new E2eeSendBlockedError(
      'no_group_state',
      'This device cannot read this encrypted conversation yet. Your message was not sent.',
    );
  }

  let ciphertext: string | null = null;
  try {
    ciphertext = await port.encryptForThread(threadId, body);
  } catch {
    ciphertext = null;
  }

  // encryptForThread returns null rather than throwing on several paths, so a
  // null check has to exist here or a null would sail past as "no ciphertext"
  // and the caller might post `{ body }`.
  if (!ciphertext) {
    throw new E2eeSendBlockedError(
      'encrypt_failed',
      'Could not encrypt this message. It was not sent.',
    );
  }

  return { ciphertext };
}

// ── Receive path ────────────────────────────────────────────────────────────

export interface IncomingMessageLike {
  id: string;
  body?: string | null;
  ciphertext?: string | null;
  msgType?: string | null;
  subtype?: string | null;
}

/** What a decrypt attempt produced, for rendering. */
export interface DecryptedMessage {
  id: string;
  body: string | null;
  /** True when this message was ciphertext this device could not read. */
  failed: boolean;
}

/**
 * Decrypt one received message.
 *
 * A failure is surfaced as `failed: true`, never as a blank or a silently
 * dropped row: an undecryptable message is a real event the user should see,
 * and hiding it makes gaps in a conversation look like nothing happened.
 */
export async function decryptIncoming(
  port: CryptoPort,
  threadId: string,
  msg: IncomingMessageLike,
): Promise<DecryptedMessage> {
  if (!msg.ciphertext) return { id: msg.id, body: msg.body ?? null, failed: false };

  if (!port.isNative() || !(await port.hasGroupSession(threadId))) {
    return { id: msg.id, body: null, failed: true };
  }

  let plaintext: string | null = null;
  try {
    plaintext = await port.decryptFromThread(threadId, msg.ciphertext);
  } catch {
    plaintext = null;
  }

  return plaintext === null
    ? { id: msg.id, body: null, failed: true }
    : { id: msg.id, body: plaintext, failed: false };
}

/** Is this the system message carrying an MLS Welcome? */
export function isWelcomeMessage(msg: IncomingMessageLike): boolean {
  return msg.msgType === 'system' && msg.subtype === E2EE_WELCOME_SUBTYPE;
}

/**
 * Join a group from a Welcome found in the thread.
 *
 * Idempotent: if a session already exists this is a no-op, so replaying the
 * message list (pagination, reconnect, a second fetch) cannot clobber live
 * group state with a stale epoch.
 */
export async function joinFromWelcomeIfNeeded(
  port: CryptoPort,
  threadId: string,
  messages: IncomingMessageLike[],
): Promise<boolean> {
  if (!port.isNative()) return false;
  if (await port.hasGroupSession(threadId)) return false;

  const welcome = messages.find(isWelcomeMessage);
  if (!welcome?.body) return false;

  const pending = await port.getPendingKeyPackageState();
  if (!pending) {
    // The KeyPackage this Welcome was encrypted to is not on this device —
    // a reinstall, or it was replaced by a newer one. Unrecoverable by design
    // (decision C1: no key backup), so leave the thread unreadable rather than
    // pretend otherwise.
    return false;
  }

  const joined = await port.initGroupAsRecipient(threadId, welcome.body, pending);
  if (joined) await port.clearPendingKeyPackageState();
  return joined;
}

// ── Negotiation ─────────────────────────────────────────────────────────────

export type NegotiationFailure =
  | 'no_native_module'
  | 'no_key_package'
  | 'group_create_failed'
  | 'welcome_delivery_failed';

export interface NegotiationResult {
  ok: boolean;
  failure?: NegotiationFailure;
}

/**
 * Establish E2EE on a NEW 1:1 thread: consume the peer's KeyPackage, create the
 * group, deliver the Welcome, then mark the thread encrypted.
 *
 * The order is load-bearing. `is_e2ee` is flipped LAST, because the server
 * refuses a plaintext body on an E2EE thread and the Welcome is a plaintext
 * system message. Flipping first would make the Welcome undeliverable and
 * strand the thread in a state where the recipient can never join.
 *
 * Every failure leaves the thread plaintext rather than half-encrypted. A
 * plaintext thread is a thread that works; a thread marked encrypted that
 * nobody can read is not.
 */
export async function establishE2ee(
  port: CryptoPort,
  threadId: string,
  userId: string,
  peerUserId: string,
  deps: {
    consumeKeyPackage: (peerUserId: string) => Promise<string | null>;
    sendWelcome: (threadId: string, welcomeB64: string) => Promise<boolean>;
    markThreadE2ee: (threadId: string) => Promise<boolean>;
  },
): Promise<NegotiationResult> {
  if (!port.isNative()) return { ok: false, failure: 'no_native_module' };

  const peerKeyPackage = await deps.consumeKeyPackage(peerUserId);
  if (!peerKeyPackage) return { ok: false, failure: 'no_key_package' };

  const created = await port.initGroupAsInitiator(threadId, userId, peerKeyPackage);
  if (!created) return { ok: false, failure: 'group_create_failed' };

  const delivered = await deps.sendWelcome(threadId, created.welcomeB64);
  if (!delivered) return { ok: false, failure: 'welcome_delivery_failed' };

  const marked = await deps.markThreadE2ee(threadId);
  if (!marked) return { ok: false, failure: 'welcome_delivery_failed' };

  return { ok: true };
}
