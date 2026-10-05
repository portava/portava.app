/**
 * ticketLink — the app's side of the ticket-link rule (REV-020,
 * docs/architecture/08_Portava_Revenue_Model.md §3.5).
 *
 * The server holds an event's ticket link to a host allowlist and to https
 * (artifacts/api-server/src/routes/events.ts, checkTicketUrl and
 * refuseTicketUrlOnUpdate). Three things on this side have to agree with it:
 *
 *   1. WHAT THE COMPOSER SENDS. `undefined` means "leave the stored link as it
 *      is" to PATCH /events/:id. The composer used to send `undefined` whenever
 *      the price was Free or the field was empty, so a link could be typed in
 *      but never taken out. It now sends `null` — an explicit "no link" — in
 *      both cases.
 *   2. HOW A REFUSAL IS RECOGNISED. Every refusal about the link is 400
 *      `invalid_payload` with a message that begins "Ticket URL". The composer
 *      shows that message at the link field, with a way to remove the link,
 *      rather than as a general failure at the bottom of the sheet.
 *   3. WHAT IS EVER OPENED. A link stored before the rule existed, or by
 *      another client, may carry any scheme. Only an https link is handed to
 *      the operating system: `javascript:` would run in the web build's own
 *      origin, `intent:` would start an arbitrary Android activity.
 *
 * Import-free so it runs under node:test.
 */

/** Every link refusal the server sends begins with this (checkTicketUrl's messages). */
export const TICKET_LINK_REFUSAL_PREFIX = 'Ticket URL';

/** True when a failed save was refused because of the ticket link. */
export function isTicketLinkRefusal(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(TICKET_LINK_REFUSAL_PREFIX);
}

/**
 * The link to send with a save: the typed link when the price is an external
 * link and one was typed, otherwise `null`. Never `undefined` — that would
 * leave whatever link the server has stored in place.
 */
export function ticketLinkForSave(priceType: 'free' | 'external', typed: string): string | null {
  const link = typed.trim();
  return priceType === 'external' && link ? link : null;
}

/**
 * The link as it may be handed to Linking.openURL, or null when it must not
 * be: anything that is not a plain `https://…` string. Deliberately a prefix
 * test on the string that will be opened, not a parse — a parser that tidies
 * `java\tscript:` into something else would be approving a different string
 * from the one the OS receives.
 */
export function openableTicketLink(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const link = url.trim();
  if (!/^https:\/\/[^\s/?#]/i.test(link)) return null;
  // No whitespace or control character anywhere: none belongs in a URL, and a
  // tab or newline is how one scheme is dressed up as another.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(link)) return null;
  return link;
}
