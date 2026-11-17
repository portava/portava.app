import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { getServiceClient } from "../lib/supabase.js";
import { configuration, validateOutputUrl } from "../lib/media/generation/higgsfield.js";
import { enqueueGeneration } from "../lib/media/generation/worker.js";

export function verifyGenerationWebhook(body: Buffer, headers: Record<string, unknown>, secret: string, now = Date.now()): string {
  const id = headers["webhook-id"], timestamp = headers["webhook-timestamp"], signature = headers["webhook-signature"];
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 || typeof signature !== "string" || signature.length > 1000 || !/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/.test(secret)) throw new Error("invalid_signature");
  const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.`).update(body).digest();
  if (!signature.split(" ").some(part => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(part)) return false;
    const supplied = Buffer.from(part.slice(3), "base64"); return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  })) throw new Error("invalid_signature");
  return id;
}
const envelope = z.object({ request_id: z.string().uuid(), status: z.enum(["completed", "failed", "nsfw"]), payload: z.unknown().nullable().optional() });
export const generationWebhookRawParser = express.raw({ type: "application/json", limit: "64kb" });
export async function generationWebhookHandler(req: Request, res: Response) {
  let eventId: string; let event: z.infer<typeof envelope>;
  const jobId = z.string().uuid().safeParse(req.params.id);
  if (!jobId.success || !Buffer.isBuffer(req.body)) { res.sendStatus(400); return; }
  try {
    eventId = verifyGenerationWebhook(req.body, req.headers, process.env.HIGGSFIELD_WEBHOOK_SECRET ?? "");
    event = envelope.parse(JSON.parse(req.body.toString("utf8")));
  } catch { res.sendStatus(400); return; }
  const persist = async () => {
    const sc = getServiceClient(); if (!sc) return 503;
    const job = await sc.from("media_generation_jobs").select("id,kind,provider_receipt").eq("id", jobId.data).maybeSingle();
    if (job.error || !job.data?.provider_receipt) return 503;
    if (job.data.provider_receipt.requestId !== event.request_id) return 400;
    const payload = event.payload as any;
    const completion = { state: event.status, ...(event.status === "completed" ? { outputUrl: validateOutputUrl(
      job.data.kind === "image" ? (payload?.images?.length === 1 ? payload.images[0]?.url : null) : payload?.video?.url, configuration().outputHosts) } : {}) };
    const saved = await sc.rpc("media_generation_complete", { p_job: jobId.data, p_event: eventId, p_request: event.request_id, p_completion: completion });
    if (saved.error || saved.data !== true) return 503;
    await enqueueGeneration(jobId.data);
    return 202;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("webhook_deadline")), 8000); });
    res.sendStatus(await Promise.race([persist(), deadline]));
  } catch { res.sendStatus(503); }
  finally { clearTimeout(timer); }
}
