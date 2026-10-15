/**
 * memoryConvergence — the owner's half of H180: the inbox lists photos that
 * belong to a Memory they already have, and only the owner's Keep attaches them
 * (census-highlights-memories H180; migration 3806; the detection half is
 * memoryConvergenceStore.ts).
 *
 *   list     GET /me/memory-candidates carries `convergence`: per Memory, the
 *            photos proposed for it ("3 photos from the same time that are not
 *            in <Memory> yet"), with the Memory's audience and the audience a
 *            kept photo will have, in the owner's own words on the client.
 *   keep     POST /me/memory-convergence/:memoryId/keep { assetIds, confirmAudience }
 *            — the owner's explicit act. Each photo goes in through §17
 *            ADD_MEDIA with an id and a key DERIVED from (Memory, photo), so a
 *            second tap, a retry or a second device reaches the same item.
 *   dismiss  POST /me/memory-convergence/:memoryId/dismiss { assetIds } — the
 *            durable negative: that photo is never proposed for that Memory again.
 *
 * ── THE AUDIENCE OF A LATE PHOTO (open owner question Q-H180-1; the plan's
 *    fail-closed default, implemented) ──────────────────────────────────────
 *   1. A Memory that is not `only_me` is shown to other people. Keep onto it is
 *      REFUSED (409 audience_unconfirmed, with the current audience) unless the
 *      request ECHOES that audience in `confirmAudience` — so a photo is never
 *      added to a public Memory by a client that showed the owner "Only me", or
 *      by one that showed "Friends" before the owner widened it to Public.
 *   2. Where per-photo audience exists (3672 deployed), every photo this Keep
 *      attaches is written `only_me`: visible to the owner alone, whatever the
 *      Memory's audience. On the direct write it is in the INSERT itself; the
 *      §17 kernel's ADD_MEDIA does not carry a photo audience, so with the
 *      kernel on it is narrowed straight after, and if that narrowing fails the
 *      photo stays at the Memory's audience — the one the owner just confirmed
 *      in step 1 — and the answer says so per photo (`itemAudience: "memory"`).
 *   Without 3672 the photo has its Memory's audience; step 1 is what the owner
 *   agreed to.
 *
 * ── ONE DECISION WINS ──────────────────────────────────────────────────────
 * Keep CLAIMS first (proposed → kept, conditional), then attaches. A Dismiss
 * that committed first makes the claim change nothing and that photo is
 * reported dismissed; a Dismiss after the claim is refused (a kept photo
 * cannot be dismissed — remove it from the Memory instead). A Keep cut off
 * after its claim leaves `kept` with no photo in the Memory: the inbox shows it
 * as interrupted and Keep again finishes it. The 3806 guard trigger makes every
 * decision final in the database too.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { probeHighlightObject } from "../highlights/highlightSchemaAvailability.js";
import { dispatchMemoryCommand } from "./MemoryDomainService.js";
import { candidateItemId, isAdmissibleCapture } from "./episodeCandidates.js";
import { classifyMemoryMediaUrl } from "./memoryMediaOrigin.js";
import { HIDDEN_ITEM_VISIBILITY, setItemVisibility } from "./memoryItemVisibility.js";
import { CONVERGENCE_TABLE, IN_CHUNK, convergenceStoreState, type ConvergenceBasis } from "./memoryConvergenceStore.js";

const log = rootLogger.child({ mod: "memoryConvergence" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most photos one Keep or Dismiss may name. */
export const MAX_ASSETS_PER_DECISION = 100;
const MAX_PROPOSED_LISTED = 500;
const MAX_KEPT_LISTED = 200;
const MAX_GROUPS_LISTED = 50;

/** The §19 key a convergence Keep carries for one photo: one per (Memory, photo), whatever the client sent. */
export const convergenceItemKey = (memoryId: string, assetId: string) => `memory-convergence-item:${candidateItemId(memoryId, assetId)}`;

/** The owner's media columns this module reads: enough for isAdmissibleCapture, the URL and the type. */
const CAPTURE_SELECT = "id, owner_user_id, public_url, mime_type, captured_at, processing_status, deleted_at, moderation_status, source_type";
interface CaptureRow {
  id: string; owner_user_id: string; public_url: string | null; mime_type: string | null; captured_at: string | null;
  processing_status: string | null; deleted_at: string | null; moderation_status: string | null; source_type: string | null;
}
interface ProposalRow { owner_id: string; memory_id: string; media_asset_id: string; basis: ConvergenceBasis; state: "proposed" | "kept" | "dismissed"; proposed_at: string; decided_at: string | null }
interface MemoryRow { id: string; owner_id: string; state: string; visibility: string | null; title: string | null; starts_at: string | null; ends_at: string | null }

function chunks<T>(xs: readonly T[], n = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** What a kept photo's audience will be: `only_me` where per-photo audience exists (3672), else the Memory's own. */
type AttachAudience = { ok: true; audience: "only_me" | "memory" } | { ok: false; detail: string };
async function attachAudience(sc: SupabaseClient | any): Promise<AttachAudience> {
  const probe = await probeHighlightObject(sc, "memory_items", ["visibility"]);
  if (probe.state === "ready") return { ok: true, audience: "only_me" };
  if (probe.state === "absent") return { ok: true, audience: "memory" };
  return { ok: false, detail: probe.reason };
}

async function readCaptures(sc: SupabaseClient | any, ownerId: string, ids: readonly string[]): Promise<{ ok: true; byId: Map<string, CaptureRow> } | { ok: false; detail: string }> {
  const byId = new Map<string, CaptureRow>();
  for (const part of chunks([...new Set(ids)])) {
    const { data, error } = await sc.from("media_assets").select(CAPTURE_SELECT).eq("owner_user_id", ownerId).in("id", part);
    if (error) return { ok: false, detail: `media_assets: ${error.message}` };
    for (const m of ((data as CaptureRow[] | null) ?? [])) if (m.owner_user_id === ownerId) byId.set(m.id, m);
  }
  return { ok: true, byId };
}

/** A photo that may be shown or attached NOW: the owner's, still admissible (re-decided at every read), in our storage or external — never another person's object. */
function attachable(m: CaptureRow | undefined, ownerId: string): m is CaptureRow & { public_url: string } {
  return Boolean(m && m.public_url && isAdmissibleCapture(m) && classifyMemoryMediaUrl(m.public_url, ownerId).verdict !== "foreign_storage");
}

/* ============================================================================
 * List
 * ==========================================================================*/

export interface ConvergencePhoto {
  assetId: string;
  previewUrl: string;
  capturedAt: string | null;
  /** `interrupted`: the owner pressed Keep and it did not finish — Keep again completes it. */
  state: "proposed" | "interrupted";
}
export interface ConvergenceGroup {
  memoryId: string;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** The Memory's CURRENT audience — what a Keep must echo when it is not `only_me`. */
  visibility: string;
  /** Who will see a kept photo: `only_me` (per-photo audience, 3672) or the Memory's audience. */
  attachAudience: "only_me" | "memory";
  basis: ConvergenceBasis;
  photos: ConvergencePhoto[];
}
export type ConvergenceInbox =
  | { state: "ready"; groups: ConvergenceGroup[] }
  | { state: "not_deployed" }
  | { state: "unavailable" };

/**
 * The owner's open proposals, grouped by Memory. Every proposal is re-checked
 * at read: the Memory still theirs and published, the photo still theirs and
 * admissible, and not already in the Memory. Never throws; an unreadable source
 * is `unavailable` — never an empty list that looks like "nothing to review".
 */
export async function listConvergence(sc: SupabaseClient | any, ownerId: string): Promise<ConvergenceInbox> {
  try {
    const store = await convergenceStoreState(sc);
    if (store.state === "not_deployed") return { state: "not_deployed" };
    if (store.state === "unavailable") { log.error({ detail: store.detail }, "memory convergence: proposals unreadable — the inbox says so rather than showing none"); return { state: "unavailable" }; }

    const fail = (detail: string): ConvergenceInbox => { log.error({ detail }, "memory convergence: a source of the inbox is unreadable — refusing rather than an empty list"); return { state: "unavailable" }; };
    const [open, kept] = await Promise.all([
      sc.from("memory_convergence_proposals").select("owner_id, memory_id, media_asset_id, basis, state, proposed_at, decided_at")
        .eq("owner_id", ownerId).eq("state", "proposed").order("proposed_at", { ascending: false }).limit(MAX_PROPOSED_LISTED),
      sc.from("memory_convergence_proposals").select("owner_id, memory_id, media_asset_id, basis, state, proposed_at, decided_at")
        .eq("owner_id", ownerId).eq("state", "kept").order("decided_at", { ascending: false }).limit(MAX_KEPT_LISTED),
    ]);
    if (open.error) return fail(`${CONVERGENCE_TABLE}: ${open.error.message}`);
    if (kept.error) return fail(`${CONVERGENCE_TABLE}: ${kept.error.message}`);
    const rows = [...((open.data as ProposalRow[] | null) ?? []), ...((kept.data as ProposalRow[] | null) ?? [])].filter((r) => r.owner_id === ownerId);
    if (rows.length === 0) return { state: "ready", groups: [] };

    const memoryIds = [...new Set(rows.map((r) => r.memory_id))];
    const memories = new Map<string, MemoryRow>();
    const urlsIn = new Map<string, Set<string>>();
    for (const part of chunks(memoryIds)) {
      const [mem, items] = await Promise.all([
        sc.from("memories").select("id, owner_id, state, visibility, title, starts_at, ends_at").eq("owner_id", ownerId).in("id", part),
        sc.from("memory_items").select("memory_id, media_url").in("memory_id", part),
      ]);
      if (mem.error) return fail(`memories: ${mem.error.message}`);
      if (items.error) return fail(`memory_items: ${items.error.message}`);
      for (const m of ((mem.data as MemoryRow[] | null) ?? [])) if (m.owner_id === ownerId) memories.set(m.id, m);
      for (const it of ((items.data as Array<{ memory_id: string; media_url: string }> | null) ?? [])) {
        const s = urlsIn.get(it.memory_id) ?? new Set<string>();
        s.add(it.media_url);
        urlsIn.set(it.memory_id, s);
      }
    }
    const captures = await readCaptures(sc, ownerId, rows.map((r) => r.media_asset_id));
    if (!captures.ok) return fail(captures.detail);
    const audience = await attachAudience(sc);
    if (!audience.ok) return fail(audience.detail);

    const groups = new Map<string, ConvergenceGroup>();
    for (const r of rows) {
      const mem = memories.get(r.memory_id);
      if (!mem || mem.state !== "published") continue;
      const cap = captures.byId.get(r.media_asset_id);
      if (!attachable(cap, ownerId)) continue;
      // Already in the Memory: a proposal is moot, and a Keep is finished.
      if (urlsIn.get(r.memory_id)?.has(cap.public_url)) continue;
      const g = groups.get(r.memory_id) ?? {
        memoryId: mem.id, title: mem.title, startsAt: mem.starts_at, endsAt: mem.ends_at,
        visibility: String(mem.visibility ?? ""), attachAudience: audience.audience, basis: r.basis, photos: [],
      };
      if (r.basis === "confirmed_episode") g.basis = "confirmed_episode";
      if (g.photos.some((p) => p.assetId === r.media_asset_id)) continue;
      g.photos.push({ assetId: r.media_asset_id, previewUrl: cap.public_url, capturedAt: cap.captured_at, state: r.state === "kept" ? "interrupted" : "proposed" });
      groups.set(r.memory_id, g);
    }
    const out = [...groups.values()];
    for (const g of out) g.photos.sort((a, b) => String(a.capturedAt ?? "").localeCompare(String(b.capturedAt ?? "")) || a.assetId.localeCompare(b.assetId));
    out.sort((a, b) => String(b.startsAt ?? "").localeCompare(String(a.startsAt ?? "")) || a.memoryId.localeCompare(b.memoryId));
    return { state: "ready", groups: out.slice(0, MAX_GROUPS_LISTED) };
  } catch (err) {
    log.error({ err: String((err as { message?: unknown })?.message ?? err) }, "memory convergence: the inbox read threw");
    return { state: "unavailable" };
  }
}

/* ============================================================================
 * Decide
 * ==========================================================================*/

/** Validate a decision's photo list: 1..MAX uuids, deduplicated. */
export function parseAssetIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ASSETS_PER_DECISION) return null;
  if (!raw.every((x) => typeof x === "string" && UUID_RE.test(x))) return null;
  return [...new Set((raw as string[]).map((x) => x.toLowerCase()))];
}

export interface KeptPhoto {
  assetId: string;
  itemId: string;
  /** `unchanged`: the photo was already in the Memory; nothing was written and its audience is what it was. */
  itemAudience: "only_me" | "memory" | "unchanged";
}
export interface SkippedPhoto { assetId: string; reason: "not_proposed" | "dismissed" | "photo_unavailable" }

export type KeepOutcome =
  | { ok: true; memoryId: string; kept: KeptPhoto[]; skipped: SkippedPhoto[] }
  | { ok: false; reason: "audience_unconfirmed"; detail: string; currentAudience: string }
  | { ok: false; reason: "nothing_to_keep"; detail: string; skipped: SkippedPhoto[] }
  | { ok: false; reason: "not_deployed" | "unavailable" | "not_found" | "memory_not_published" | "write_failed" | "kernel_refused"; detail: string };

async function loadOwnMemory(sc: SupabaseClient | any, ownerId: string, memoryId: string): Promise<{ ok: true; row: MemoryRow } | { ok: false; reason: "unavailable" | "not_found"; detail: string }> {
  if (!UUID_RE.test(memoryId)) return { ok: false, reason: "not_found", detail: "not an id" };
  const { data, error } = await sc.from("memories").select("id, owner_id, state, visibility, title, starts_at, ends_at").eq("id", memoryId).maybeSingle();
  if (error) return { ok: false, reason: "unavailable", detail: `memories: ${error.message}` };
  const row = data as MemoryRow | null;
  // Another person's Memory is the same answer as a missing one.
  if (!row || row.owner_id !== ownerId || row.state === "deleted") return { ok: false, reason: "not_found", detail: "no such Memory for this owner" };
  return { ok: true, row };
}

async function readDecisions(sc: SupabaseClient | any, ownerId: string, memoryId: string, assetIds: readonly string[]): Promise<{ ok: true; byAsset: Map<string, ProposalRow> } | { ok: false; detail: string }> {
  const byAsset = new Map<string, ProposalRow>();
  for (const part of chunks(assetIds)) {
    const { data, error } = await sc
      .from("memory_convergence_proposals")
      .select("owner_id, memory_id, media_asset_id, basis, state, proposed_at, decided_at")
      .eq("owner_id", ownerId)
      .eq("memory_id", memoryId)
      .in("media_asset_id", part);
    if (error) return { ok: false, detail: `${CONVERGENCE_TABLE}: ${error.message}` };
    for (const r of ((data as ProposalRow[] | null) ?? [])) if (r.owner_id === ownerId && r.memory_id === memoryId) byAsset.set(r.media_asset_id, r);
  }
  return { ok: true, byAsset };
}

/**
 * The owner keeps proposed photos for one of their Memories. See the module
 * header for the audience rule and the claim order.
 */
export async function keepConvergence(
  sc: SupabaseClient | any,
  input: { ownerId: string; memoryId: string; assetIds: readonly string[]; confirmAudience: string | null; now: Date },
): Promise<KeepOutcome> {
  const store = await convergenceStoreState(sc);
  if (store.state !== "ready") return { ok: false, reason: store.state, detail: store.detail };
  const loaded = await loadOwnMemory(sc, input.ownerId, input.memoryId);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail };
  const mem = loaded.row;
  if (mem.state !== "published") return { ok: false, reason: "memory_not_published", detail: `a ${mem.state} Memory takes no photos here` };

  // (1) THE AUDIENCE ECHO. Required whenever the Memory is seen by anyone but
  //     its owner; checked against the row read NOW, so a widening the client
  //     never showed is a refusal, not a silent publish. An echo that does not
  //     match is refused for an only_me Memory too: the client showed the owner
  //     an audience this Memory no longer has.
  const current = String(mem.visibility ?? "");
  if ((current !== "only_me" || input.confirmAudience != null) && input.confirmAudience !== current) {
    return { ok: false, reason: "audience_unconfirmed", detail: "the request did not confirm the Memory's current audience", currentAudience: current };
  }

  const decisions = await readDecisions(sc, input.ownerId, input.memoryId, input.assetIds);
  if (!decisions.ok) return { ok: false, reason: "unavailable", detail: decisions.detail };
  const audience = await attachAudience(sc);
  if (!audience.ok) return { ok: false, reason: "unavailable", detail: audience.detail };

  const skipped: SkippedPhoto[] = [];
  const wanted: string[] = [];
  for (const id of input.assetIds) {
    const d = decisions.byAsset.get(id);
    if (!d) skipped.push({ assetId: id, reason: "not_proposed" });
    else if (d.state === "dismissed") skipped.push({ assetId: id, reason: "dismissed" });
    else wanted.push(id);
  }
  const captures = await readCaptures(sc, input.ownerId, wanted);
  if (!captures.ok) return { ok: false, reason: "unavailable", detail: captures.detail };
  const usable = wanted.filter((id) => {
    if (attachable(captures.byId.get(id), input.ownerId)) return true;
    skipped.push({ assetId: id, reason: "photo_unavailable" });
    return false;
  });
  if (usable.length === 0) return { ok: false, reason: "nothing_to_keep", detail: "none of these photos can be added", skipped };

  // (2) CLAIM, conditionally: only a still-proposed row moves to kept. A row
  //     already kept is an interrupted Keep this call completes.
  const toClaim = usable.filter((id) => decisions.byAsset.get(id)!.state === "proposed");
  if (toClaim.length > 0) {
    const { error: claimErr } = await sc
      .from("memory_convergence_proposals")
      .update({ state: "kept", decided_at: input.now.toISOString() })
      .eq("owner_id", input.ownerId)
      .eq("memory_id", input.memoryId)
      .eq("state", "proposed")
      .in("media_asset_id", toClaim)
      .select("media_asset_id");
    if (claimErr) return { ok: false, reason: "write_failed", detail: `${CONVERGENCE_TABLE} claim: ${claimErr.message}` };
  }
  const after = await readDecisions(sc, input.ownerId, input.memoryId, usable);
  if (!after.ok) return { ok: false, reason: "unavailable", detail: after.detail };
  const claimed = usable.filter((id) => {
    if (after.byAsset.get(id)?.state === "kept") return true;
    // A Dismiss committed between the read and the claim: it won.
    skipped.push({ assetId: id, reason: after.byAsset.get(id)?.state === "dismissed" ? "dismissed" : "not_proposed" });
    return false;
  });
  if (claimed.length === 0) return { ok: false, reason: "nothing_to_keep", detail: "these photos were decided while this Keep ran", skipped };

  // (3) ATTACH through §17 ADD_MEDIA, in capture order, after the photos already there.
  const { data: itemData, error: itemErr } = await sc.from("memory_items").select("id, media_url, position").eq("memory_id", input.memoryId);
  if (itemErr) return { ok: false, reason: "unavailable", detail: `memory_items: ${itemErr.message}` };
  const items = ((itemData as Array<{ id: string; media_url: string; position: number | null }> | null) ?? []);
  const haveUrl = new Map(items.map((i) => [i.media_url, i.id]));
  let position = items.reduce((mx, i) => Math.max(mx, Number(i.position ?? 0)), -1) + 1;
  const ordered = claimed
    .map((id) => captures.byId.get(id)!)
    .sort((a, b) => String(a.captured_at ?? "").localeCompare(String(b.captured_at ?? "")) || a.id.localeCompare(b.id));

  const kept: KeptPhoto[] = [];
  for (const m of ordered) {
    const url = m.public_url!;
    const already = haveUrl.get(url);
    if (already) { kept.push({ assetId: m.id, itemId: already, itemAudience: "unchanged" }); continue; }
    const itemId = candidateItemId(input.memoryId, m.id);
    const item = { id: itemId, memory_id: input.memoryId, media_url: url, media_type: m.mime_type ?? "image/jpeg", caption: null, position };
    let viaDirectWrite = false;
    const added = await dispatchMemoryCommand<{ id: string }>({
      sc,
      commandType: "ADD_MEDIA",
      memoryId: input.memoryId,
      actorUserId: input.ownerId,
      idempotencyKey: convergenceItemKey(input.memoryId, m.id),
      payload: { media_type: item.media_type, position, write: item },
      fromKernelResult: (r: unknown) => ({ id: String(((r ?? {}) as { id?: unknown }).id ?? "") }),
      legacy: async () => {
        viaDirectWrite = true;
        // The photo's audience is IN the insert: there is no moment it is visible wider.
        const row = audience.audience === "only_me" ? { ...item, visibility: HIDDEN_ITEM_VISIBILITY } : item;
        const { data, error } = await sc.from("memory_items").insert(row).select("id").single();
        if (!error) return { ok: true, body: { id: String((data as { id: string }).id) } };
        // A concurrent or earlier Keep attached this exact photo (derived id).
        if (String((error as { code?: string }).code ?? "") === "23505") return { ok: true, body: { id: itemId } };
        return { ok: false, http: { code: "db_error", message: error.message } };
      },
    });
    if (!added.ok) {
      const detail = "rejection" in added ? added.rejection.reason : added.http.message;
      return { ok: false, reason: "kernel_refused", detail: `attaching a photo: ${String(detail)}` };
    }
    let itemAudience: KeptPhoto["itemAudience"] = audience.audience;
    if (audience.audience === "only_me" && !viaDirectWrite) {
      // The kernel's ADD_MEDIA takes no photo audience: narrow it now. If that
      // fails, the photo has the audience the owner just confirmed — say so.
      const narrowed = await setItemVisibility(sc, { memoryId: input.memoryId, itemId: added.body.id, visibility: HIDDEN_ITEM_VISIBILITY });
      if (!narrowed.ok) {
        log.error({ memoryId: input.memoryId, reason: narrowed.reason }, "memory convergence: a kept photo could not be made owner-only after the kernel attached it; it has the Memory's confirmed audience");
        itemAudience = "memory";
      }
    }
    kept.push({ assetId: m.id, itemId: added.body.id, itemAudience });
    haveUrl.set(url, added.body.id);
    position += 1;
  }
  return { ok: true, memoryId: input.memoryId, kept, skipped };
}

export type DismissOutcome =
  | { ok: true; memoryId: string; dismissed: string[]; alreadyDismissed: string[]; refused: Array<{ assetId: string; reason: "kept" | "not_proposed" }> }
  | { ok: false; reason: "nothing_to_dismiss"; detail: string; refused: Array<{ assetId: string; reason: "kept" | "not_proposed" }> }
  | { ok: false; reason: "not_deployed" | "unavailable" | "not_found" | "write_failed"; detail: string };

/** The owner says these photos do not belong to this Memory. Durable: the detector's insert never reopens a decided row. */
export async function dismissConvergence(
  sc: SupabaseClient | any,
  input: { ownerId: string; memoryId: string; assetIds: readonly string[]; now: Date },
): Promise<DismissOutcome> {
  const store = await convergenceStoreState(sc);
  if (store.state !== "ready") return { ok: false, reason: store.state, detail: store.detail };
  const loaded = await loadOwnMemory(sc, input.ownerId, input.memoryId);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail };
  const before = await readDecisions(sc, input.ownerId, input.memoryId, input.assetIds);
  if (!before.ok) return { ok: false, reason: "unavailable", detail: before.detail };
  const open = input.assetIds.filter((id) => before.byAsset.get(id)?.state === "proposed");
  if (open.length > 0) {
    const { error } = await sc
      .from("memory_convergence_proposals")
      .update({ state: "dismissed", decided_at: input.now.toISOString() })
      .eq("owner_id", input.ownerId)
      .eq("memory_id", input.memoryId)
      .eq("state", "proposed")
      .in("media_asset_id", open)
      .select("media_asset_id");
    if (error) return { ok: false, reason: "write_failed", detail: `${CONVERGENCE_TABLE} dismiss: ${error.message}` };
  }
  const after = await readDecisions(sc, input.ownerId, input.memoryId, input.assetIds);
  if (!after.ok) return { ok: false, reason: "unavailable", detail: after.detail };
  const dismissed: string[] = [];
  const alreadyDismissed: string[] = [];
  const refused: Array<{ assetId: string; reason: "kept" | "not_proposed" }> = [];
  for (const id of input.assetIds) {
    const now = after.byAsset.get(id)?.state;
    if (now === "dismissed") (before.byAsset.get(id)?.state === "dismissed" ? alreadyDismissed : dismissed).push(id);
    else if (now === "kept") refused.push({ assetId: id, reason: "kept" });
    else refused.push({ assetId: id, reason: "not_proposed" });
  }
  if (dismissed.length + alreadyDismissed.length === 0) return { ok: false, reason: "nothing_to_dismiss", detail: "none of these photos is an open proposal for this Memory", refused };
  return { ok: true, memoryId: input.memoryId, dismissed, alreadyDismissed, refused };
}
