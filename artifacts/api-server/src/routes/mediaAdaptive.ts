import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import type { SelfHostedAdaptive } from "../lib/media/adaptive/service.js";
import { validAssetId, validFile, validVersion } from "../lib/media/adaptive/types.js";
import { adaptiveAssetForReference } from "../lib/media/adaptive/canonical.js";

export function adaptiveByteRange(header: string | undefined, length: number): { start: number; end: number } | null | false {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return false;
  const start = first ?? Math.max(0, length - (last ?? 0));
  const end = first === null || last === null ? length - 1 : Math.min(last, length - 1);
  return start < 0 || start >= length || end < start ? false : { start, end };
}

export function createMediaAdaptiveRouter(resolveRuntime: (sc: SupabaseClient) => Pick<SelfHostedAdaptive, "playback" | "readFile"> | null) {
  const router = Router();
  router.get(["/media/adaptive/source", "/media/adaptive/:assetId/playback", "/media/adaptive/:assetId/:generation/:filename"], asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", "Authorization, Cookie");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const auth = await requireUser(req, res);
    if (!auth) return;
    if (!checkRateLimit("media_adaptive", auth.user.id, 180, 60_000).allowed) { res.sendStatus(429); return; }
    const sc = getServiceClient();
    if (!sc) { res.sendStatus(404); return; }
    try {
      const runtime = resolveRuntime(sc);
      if (!runtime) { res.sendStatus(404); return; }
      const assetId = req.params.assetId ? String(req.params.assetId)
        : typeof req.query.source === "string" ? await adaptiveAssetForReference(sc, req.query.source) : null;
      if (!assetId || !validAssetId(assetId)) { res.sendStatus(404); return; }
      if (!req.params.filename) {
        const playback = await runtime.playback(auth.user.id, assetId);
        if (!playback) { res.sendStatus(404); return; }
        res.json({ ...playback, assetId });
        return;
      }
      const filename = String(req.params.filename);
      const generation = Number(req.params.generation);
      if (!/^[1-9]\d*$/.test(String(req.params.generation)) || !validVersion(generation) || !validFile(filename)) { res.sendStatus(404); return; }
      const bytes = await runtime.readFile(auth.user.id, assetId, generation, filename);
      if (!bytes) { res.sendStatus(404); return; }
      const range = adaptiveByteRange(req.headers.range, bytes.length);
      if (range === false) { res.setHeader("Content-Range", `bytes */${bytes.length}`); res.sendStatus(416); return; }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", filename.endsWith(".ts") ? "video/mp2t" : filename === "preview.jpg" ? "image/jpeg" : "application/vnd.apple.mpegurl");
      if (range) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${bytes.length}`);
      }
      const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
      res.setHeader("Content-Length", body.length);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch { res.sendStatus(404); }
  }));
  return router;
}
