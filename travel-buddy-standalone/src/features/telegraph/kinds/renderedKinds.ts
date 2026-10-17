/**
 * The §6.2 typed kinds the conversation's TypedMessageRenderer draws, by their
 * stored `msgType` — ONE list, read by two consumers so they cannot disagree:
 *
 *   - `rendersTypedKind` (TypedMessageRenderer.tsx), the conversation screen's
 *     dispatch: a row of one of these types is drawn by the typed renderer;
 *   - the §30A.16 capability header (negotiation/clientCapabilities.ts,
 *     census-telegraph T431): the schemas this client tells the server it can
 *     render are derived from this list, so a kind is declared exactly when the
 *     renderer draws it.
 *
 * Pure data, no imports — the api-server's cross-tree negotiation test imports
 * it under node.
 */
export const TYPED_RENDERED_MSG_TYPES = [
  'media_album', 'gif', 'location', 'action', 'announcement', 'safety', 'memory_note', 'voice',
] as const;

export type TypedRenderedMsgType = (typeof TYPED_RENDERED_MSG_TYPES)[number];
