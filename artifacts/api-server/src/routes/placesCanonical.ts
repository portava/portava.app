/**
 * Canonical external-place routes (media audit Phase 6).
 *
 *   GET  /api/places/canonical/:id        — normalized place + all provider refs
 *   POST /api/admin/places/ingest         — resolve provider records → places (admin)
 *   POST /api/admin/places/:id/merge      — merge :id into { intoId } (admin)
 *   POST /api/admin/places/:id/unmerge    — reverse a merge (admin)
 *
 * Flag-gated by `external_places_enabled` (OFF = dormant; reads 404, ingest
 * no-ops via the resolver). Merge model is LOSSLESS: a merged place keeps its
 * own references and just points `merged_into_place_id` at the survivor; the
 * canonical read aggregates across the group, so unmerge is a one-field revert.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { resolveExternalPlace, toCanonicalPlace, type ExternalPlaceRecord } from "../lib/places/placeResolve.js";
import { requireAdmin } from "../lib/requireAdmin.js";

import { readCanonicalPlaceGroup, readCanonicalPlaceVisibility } from "../lib/places/placeGovernance.js";
import { checkRateLimit } from "../lib/rateLimit.js";
const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── GET /api/places/canonical/:id ─────────────────────────────────────────────
router.get("/places/canonical/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(sc, "external_places_enabled"))) { sendError(res, "feature_disabled"); return; }

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  const group = await readCanonicalPlaceGroup(sc,id);
  if (!group.ok) { sendError(res,group.reason === 'not_found' ? 'not_found' : 'degraded_unavailable','Place unavailable'); return; }
  res.setHeader('Cache-Control','no-store');
  res.json({ place: toCanonicalPlace(group.place,group.refs) });
}));

// ── POST /api/admin/places/ingest ─────────────────────────────────────────────
const recordSchema = z.object({
  provider: z.string().min(1).max(40),
  providerPlaceId: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  primaryCategory: z.string().max(80).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  neighborhood: z.string().max(200).nullable().optional(),
  countryCode: z.string().max(4).nullable().optional(),
  providerUrl: z.string().url().max(1000).nullable().optional(),
  attribution: z.string().max(200).nullable().optional(),
  rawCategory: z.string().max(120).nullable().optional(),
  canonicalLocationId: z.string().uuid().nullable().optional(),
});

router.post("/admin/places/ingest", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = z.object({ records: z.array(recordSchema).min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid records"); return; }

  if (!(await isFlagEnabled(admin.sc, "external_places_enabled"))) { sendError(res, "feature_disabled"); return; }

  let created = 0, linked = 0, skipped = 0;
  const placeIds: string[] = [];
  for (const rec of parsed.data.records) {
    const r = await resolveExternalPlace(admin.sc, rec as ExternalPlaceRecord);
    if (!r) { skipped++; continue; }
    placeIds.push(r.placeId);
    if (r.created) created++; else linked++;
  }
  res.json({ ok: true, created, linked, skipped, placeIds });
}));

// Audited ownerless place governance. Exact retries recover the original receipt.
const actionSchema=z.enum(['withhold','restore','merge','unmerge']);
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const contextInput=z.object({action:actionSchema,reportId:uuid.optional(),intoId:uuid.optional()}).strict();
const confirmation=z.object({action:actionSchema,reportId:uuid.optional(),intoId:uuid.optional(),
  reason:z.string().trim().min(1).max(1000),contextToken:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const placeContext=z.object({contractVersion:z.literal(1),placeId:uuid,reportId:uuid.nullable(),action:actionSchema,intoId:uuid.nullable(),
  name:z.string(),status:z.string(),moderationStatus:z.enum(['visible','withheld']),mergedIntoId:uuid.nullable(),restoreStatus:z.string(),
  destinationName:z.string().nullable(),contextToken:z.string().regex(/^[0-9a-f]{64}$/)});
const placeReceipt=z.object({ok:z.literal(true),contractVersion:z.literal(1),placeId:uuid,reportId:uuid.nullable(),action:actionSchema,
  intoId:uuid.nullable(),operationId:uuid,auditId:uuid,replayed:z.boolean(),committedAt:z.string().datetime({offset:true})});
function governanceError(res:Parameters<typeof sendError>[0],code?:string) {
  sendError(res,code==='PT400'?'invalid_payload':code==='PT403'?'forbidden':code==='PT404'?'not_found':code==='PT409'?'conflict':'degraded_unavailable',
    code==='PT409'?'Place or report changed, or the report target is ambiguous. Reload before confirming.':'Place action unavailable. Retry an uncertain submission with the same operation.');
}
router.get('/admin/places/:id/governance',asyncHandler(async(req,res)=>{
  const admin=await requireAdmin(req,res);if(!admin)return;
  const id=uuid.safeParse(req.params.id),input=contextInput.safeParse(req.query);
  if(!id.success||!input.success){governanceError(res,'PT400');return;}
  if(!checkRateLimit('place-governance',admin.userId,60,60000).allowed){sendError(res,'rate_limited');return;}
  try {
    const {data,error}=await admin.sc.rpc('get_place_governance_context',{p_admin_id:admin.userId,p_id:id.data,p_action:input.data.action,
      p_report_id:input.data.reportId??null,p_into_id:input.data.intoId??null}).abortSignal(AbortSignal.timeout(6000));
    if(error){governanceError(res,error.code);return;}
    const parsed=placeContext.safeParse(data);
    if(!parsed.success||parsed.data.placeId!==id.data||parsed.data.action!==input.data.action
      ||parsed.data.reportId!==(input.data.reportId??null)||parsed.data.intoId!==(input.data.intoId??null)){governanceError(res);return;}
    res.setHeader('Cache-Control','no-store');res.json(parsed.data);
  }catch{governanceError(res);}
}));
const applyGovernance=asyncHandler(async(req,res)=>{
  const admin=await requireAdmin(req,res);if(!admin)return;
  const id=uuid.safeParse(req.params.id),input=confirmation.safeParse(req.body),operation=uuid.safeParse(req.headers['idempotency-key']);
  const headerCount=req.rawHeaders.filter((value:string,index:number)=>index%2===0&&value.toLowerCase()==='idempotency-key').length;
  if(!id.success||!input.success||!operation.success||headerCount!==1
    ||(req.path.endsWith('/merge')&&input.data.action!=='merge')||(req.path.endsWith('/unmerge')&&input.data.action!=='unmerge')){governanceError(res,'PT400');return;}
  if(!checkRateLimit('place-governance',admin.userId,60,60000).allowed){sendError(res,'rate_limited');return;}
  try {
    const {data,error}=await admin.sc.rpc('apply_place_governance_action',{p_admin_id:admin.userId,p_id:id.data,p_action:input.data.action,
      p_report_id:input.data.reportId??null,p_into_id:input.data.intoId??null,p_operation_id:operation.data,p_reason:input.data.reason,
      p_expected_context_token:input.data.contextToken}).abortSignal(AbortSignal.timeout(6000));
    if(error){governanceError(res,error.code);return;}
    const parsed=placeReceipt.safeParse(data);
    if(!parsed.success||parsed.data.operationId!==operation.data||parsed.data.placeId!==id.data||parsed.data.action!==input.data.action
      ||parsed.data.reportId!==(input.data.reportId??null)||parsed.data.intoId!==(input.data.intoId??null)){governanceError(res);return;}
    res.setHeader('Cache-Control','no-store');res.json(parsed.data);
  }catch{governanceError(res);}
});
router.post('/admin/places/:id/governance',applyGovernance);
router.post('/admin/places/:id/merge',applyGovernance);
router.post('/admin/places/:id/unmerge',applyGovernance);

// ── GET /api/places/:id/thin-buckets ─────────────────────────────────────────
/**
 * Returns coverage buckets for a place that have fewer than 5 posts, sorted by
 * scarcity (lowest post_count first).  Used by the Living Page UI to show
 * "Be the first" content prompts.
 *
 * Cached 30 min per place (in-process, LRU-style Map).
 */

const THIN_BUCKET_THRESHOLD = 5;
const THIN_BUCKET_CACHE_TTL_MS = 30 * 60 * 1_000; // 30 min
const thinBucketCache = new Map<string, { data: any; expiresAt: number }>();

router.get("/places/:id/thin-buckets", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  const visible=await readCanonicalPlaceVisibility(sc,[id]);
  if(!visible.ok){sendError(res,'degraded_unavailable','Place visibility unavailable');return;}
  if(!visible.visibleIds.has(id)){sendError(res,'not_found');return;}
  res.setHeader('Cache-Control','no-store');
  // In-process cache
  const cached = thinBucketCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.data);
    return;
  }

  const { data, error } = await sc
    .from("place_coverage_buckets")
    .select("bucket, post_count")
    .eq("canonical_place_id", id)
    .lt("post_count", THIN_BUCKET_THRESHOLD)
    .order("post_count", { ascending: true });

  if (error || !Array.isArray(data)) { sendError(res, "degraded_unavailable"); return; }

  const buckets = ((data as any[]) ?? []).map((row) => ({
    bucket:     row.bucket as string,
    post_count: row.post_count as number,
  }));

  const response = { buckets };
  thinBucketCache.set(id, { data: response, expiresAt: Date.now() + THIN_BUCKET_CACHE_TTL_MS });

  res.json(response);
}));

export default router;
