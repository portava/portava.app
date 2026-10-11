/**
 * PR-TREL-5 (lead ruling, 2026-10-10) — §15.3 "Blocking must cascade across …
 * LOCATION …" on the READ path (census-telegraph T219, §76).
 *
 * A LOCATION message carries a place: `label`, `approximateLabel`, `placeId`
 * and — when the sender opted into `exact` — `lat`/`lng`. P-T5 withholds a
 * blocked person's IDENTITY in a shared group thread but leaves their content;
 * for a location that is not enough. So a viewer in a block with the sender, in
 * EITHER direction, gets a placeholder in place of the payload: the kind is
 * kept (the thread still shows that something was shared), and nothing that
 * says where. When block state cannot be read, every other sender's LOCATION is
 * withheld (fail closed) — the request itself still answers.
 *
 * ONE helper for every surface that serialises a message body to a viewer, so
 * the surfaces cannot disagree: the thread page and its quoted replies, the
 * inbox preview, saved messages, edit history, the content drawer and in-thread
 * search, the layers / catch-up / safety-mode projections, memory drafts and
 * plan recaps. Cross-conversation search DROPS a withheld row instead (the match
 * itself was made against withheld text). The realtime bus and the stream
 * replays never carry a body (ids, kind and timestamps only); there is no
 * message push.
 *
 * The sender always sees their own message in full; so does every member not
 * in a block with the sender.
 */
import { readBlockExclusions } from "../../lib/exclusionSet.js";

export const LOCATION_MSG_TYPE = "location";

/** The placeholder envelope: a valid LOCATION envelope with nothing that says where. */
export const LOCATION_WITHHELD_PAYLOAD = Object.freeze({ label: "Location shared", precision: "area" as const });
export const LOCATION_WITHHELD_BODY = JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: LOCATION_WITHHELD_PAYLOAD });

/** Marker on a row whose payload was withheld, for callers that must also skip derived reads (translations, spans). */
export const LOCATION_WITHHELD = Symbol.for("telegraph.locationWithheld");

export function isLocationRow(row: { msg_type?: unknown } | null | undefined): boolean {
  return typeof row?.msg_type === "string" && row.msg_type.toLowerCase() === LOCATION_MSG_TYPE;
}

export function isLocationWithheld(row: unknown): boolean {
  return Boolean(row && typeof row === "object" && (row as Record<symbol, unknown>)[LOCATION_WITHHELD]);
}

/**
 * Which of these rows the viewer may NOT see the location of. One block read
 * for every other sender of a LOCATION row; unreadable ⇒ all of them.
 */
export async function withheldLocationIds(
  sc: any,
  viewerId: string,
  rows: ReadonlyArray<{ id?: unknown; sender_id?: unknown; msg_type?: unknown }>,
): Promise<Set<string>> {
  const loc = rows.filter((r) => isLocationRow(r) && typeof r.sender_id === "string" && r.sender_id !== viewerId);
  if (loc.length === 0) return new Set();
  const senders = [...new Set(loc.map((r) => String(r.sender_id)))];
  let blocked: ReadonlySet<string> | null = null;
  try {
    const ex = await readBlockExclusions(sc, viewerId, { among: senders });
    if (ex.ok) blocked = ex.ids;
  } catch {
    blocked = null;
  }
  return new Set(loc.filter((r) => blocked === null || blocked.has(String(r.sender_id))).map((r) => String(r.id)));
}

/**
 * Rows with each withheld LOCATION payload replaced by the placeholder (copies;
 * the inputs are not mutated). `bodyKeys` names every field on the row that
 * carries the envelope (e.g. `body`, an edit's `previous_body`).
 */
export async function withholdLocationAcrossBlocks<T extends { id?: unknown; sender_id?: unknown; msg_type?: unknown }>(
  sc: any,
  viewerId: string,
  rows: T[],
  bodyKeys: readonly string[] = ["body"],
): Promise<{ rows: T[]; withheld: Set<string> }> {
  const withheld = await withheldLocationIds(sc, viewerId, rows);
  if (withheld.size === 0) return { rows, withheld };
  const out = rows.map((r) => {
    if (!withheld.has(String(r.id))) return r;
    const copy: Record<string | symbol, unknown> = { ...(r as Record<string, unknown>) };
    for (const k of bodyKeys) if (k in copy) copy[k] = LOCATION_WITHHELD_BODY;
    if ("subtype" in copy) copy.subtype = LOCATION_WITHHELD_PAYLOAD.precision;
    copy[LOCATION_WITHHELD] = true;
    return copy as T;
  });
  return { rows: out, withheld };
}
