/**
 * Telegraph §30A.13 / census T430 — the SAFE half of "unknown future message
 * types render a safe generic fallback on older clients".
 *
 * THE DEFECT THIS CLOSES. Two thirds of that requirement were already true:
 * nothing crashes and nothing silently disappears. An unknown
 * `msg_type:'system'` subtype falls to the centred pill and an unknown
 * `msgType` falls through every branch to the ordinary bubble. Neither is
 * SAFE, because Telegraph's structured payloads live in `messages.body` as a
 * JSON string (census T157) and both fallbacks render `body` as literal text.
 * So a client that met a kind it did not know showed the reader the payload:
 * `{"kind":"SAFETY","envelopeVersion":"1","payload":{...}}`, ids, urls and
 * all. That is the exact failure mode the requirement names — the fallback
 * existed and leaked the machine's own wire format at the reader.
 *
 * THE RULE, and why it is this narrow. Only a body that is unambiguously a
 * machine payload is replaced: it must start with `{` or `[` *and* parse as
 * JSON. A person who types `hello`, `:-)`, `{` or `42` into a composer sees
 * exactly what they typed, because none of those parse to a container. The
 * false positive that remains — somebody deliberately sending a JSON object as
 * chat text — is accepted knowingly, and it is why this helper is applied ONLY
 * on paths the client did not recognise. A plain `text` message never reaches
 * it: `text` is a known type and is rendered by its own branch.
 *
 * An EMPTY body on an unrecognised type is also replaced, because "silently
 * disappearing" is the other half of the same sentence: a pill containing the
 * empty string is a message that vanished.
 *
 * WHAT THIS IS NOT. It is not a decoder and it is not an upgrade prompt tied
 * to a version check — there is no client-version channel to tie it to. It is
 * one sentence that tells the reader a message is here and that this build
 * cannot draw it, which is the most an older client can truthfully say.
 */

/**
 * The one sentence an older client can honestly say about a kind it does not
 * know. Exported so tests and every call site name the same string rather than
 * three drifting copies.
 */
export const UNSUPPORTED_MESSAGE_TEXT = 'This message can’t be shown in this version of Portava.';

/**
 * True when `body` is a machine payload rather than something a person typed.
 *
 * Conservative on purpose: JSON that parses to a primitive (`42`, `"hi"`,
 * `true`, `null`) is NOT a payload, because a person can type all of those and
 * because no payload in this system is a bare scalar. Only an object or an
 * array counts, and the FIRST CHARACTER is what decides that.
 */
export function isMachinePayload(body: string | null | undefined): boolean {
  if (typeof body !== 'string') return false;
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  // The load-bearing line. A JSON value that starts with anything else is a
  // scalar, and a scalar is something a person can type.
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(trimmed);
  } catch {
    return false;
  }
  /*
    NO `typeof parsed === 'object'` CHECK, deliberately, and this is recorded
    rather than quietly omitted. One was written here first. Deleting it left
    every test in this suite GREEN, which is the measurement that matters: by
    JSON's own grammar a value that starts with `{` or `[` and parses is an
    object or an array, so the check could never be reached and be false. A
    guard with no observable effect is not defence in depth — it is something a
    later reader will trust. The first-character test above is the real one.
  */
  return true;
}

/**
 * The text a surface should draw for a message whose type it does not know.
 *
 * Returns the body unchanged when it is real prose — an unrecognised SUBTYPE
 * whose body is a human sentence ("Trip plan updated") still reads as that
 * sentence, which is the behaviour this must not regress while closing the
 * leak.
 */
export function safeUnknownBody(body: string | null | undefined): string {
  if (typeof body !== 'string' || body.trim().length === 0) return UNSUPPORTED_MESSAGE_TEXT;
  if (isMachinePayload(body)) return UNSUPPORTED_MESSAGE_TEXT;
  return body;
}

/**
 * The `msgType` values the conversation surface has a branch for.
 *
 * Anything outside this set is a FUTURE type as far as this build is
 * concerned, and is the population §30A.13 is about. The typed-kind names are
 * included because `TypedMessageRenderer` already handles them and already
 * refuses to print their payload — see its `telegraph-typed-unreadable`
 * branch.
 */
export const KNOWN_MESSAGE_TYPES: readonly string[] = [
  'text',
  'media',
  'system',
  'portava_object',
  'circle_status_card',
  'ai_recommendation',
  'location',
  'voice',
  // typed §6.2 kinds, handled by TypedMessageRenderer
  'media_album',
  'gif',
  'action',
  'announcement',
  'safety',
  'memory_note',
];

/** False for a message type this build has no branch for. */
export function rendersKnownMessageType(msgType: string | null | undefined): boolean {
  if (typeof msgType !== 'string' || msgType.length === 0) return true; // absent → ordinary text
  return KNOWN_MESSAGE_TYPES.includes(msgType.toLowerCase());
}
