/** Server-only Higgsfield REST adapter. No SDK globals, automatic paid retries,
 * reference uploads, arbitrary model paths, or client-supplied callback URLs. */
import { z } from "zod";
import { approvedProviderModel, providerModel } from "../../providerVersions.js";

export const GENERATION_POLICY = "higgsfield-text-generation-v1";
export const GENERATION_BUCKET = "generated-media-private";
export const models = {
  image: { id: providerModel("higgsfield", "higgsfield-ai/soul/v2/standard"), baseline: "higgsfield-ai/soul/v2/standard", label: "Higgsfield image", estimateUsd: 0.0057 },
  video: { id: providerModel("higgsfield", "bytedance/seedance-2.5/text-to-video"), baseline: "bytedance/seedance-2.5/text-to-video", label: "Higgsfield video", estimateUsd: 1.3235 },
} as const;
export const generationInput = z.object({
  requestId: z.string().uuid(),
  kind: z.enum(["image", "video"]),
  prompt: z.string().trim().min(3).max(2000),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  consentVersion: z.literal(GENERATION_POLICY),
}).strict();
export type GenerationInput = z.infer<typeof generationInput>;
export type GenerationKind = GenerationInput["kind"];
export type GenerationState = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";
export interface ProviderReceipt { requestId: string; statusUrl: string }
export interface ProviderStatus { state: GenerationState; outputUrl?: string }

export class GenerationError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) { super(code); }
}
const API = "https://api.higgsfield.ai";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Env = Record<string, string | undefined>;

export function configuration(env: Env = process.env) {
  const credentials = env.HIGGSFIELD_CREDENTIALS?.trim() ?? "";
  const outputHosts = (env.HIGGSFIELD_OUTPUT_HOSTS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const validHost = (host: string) => /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(host) && !/^[\d.]+$/.test(host) &&
    !host.endsWith(".local") && !host.endsWith(".internal") && host !== "localhost" && !host.endsWith(".localhost");
  let webhookBase = "";
  try {
    const url = new URL(env.HIGGSFIELD_WEBHOOK_BASE_URL ?? "");
    if (url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash && !url.port) webhookBase = url.origin;
  } catch { /* incomplete configuration stays disabled */ }
  return {
    credentials, outputHosts,
    ready: /^[\x21-\x39\x3b-\x7e]+:[\x21-\x39\x3b-\x7e]+$/.test(credentials) &&
      outputHosts.length > 0 && outputHosts.every(validHost) && env.HIGGSFIELD_DATA_POLICY_REVIEWED === "true" && !!webhookBase &&
      /^whsec_[A-Za-z0-9+/]{32,}={0,2}$/.test(env.HIGGSFIELD_WEBHOOK_SECRET ?? "") && !!env.REDIS_URL,
    webhookBase,
  };
}

export function modelInput(input: Pick<GenerationInput, "kind" | "prompt" | "aspectRatio">) {
  return input.kind === "image"
    ? { prompt: input.prompt, batch_size: 1, resolution: "1080p", aspect_ratio: input.aspectRatio, enhance_prompt: false }
    : { prompt: input.prompt, duration: 5, resolution: "720p", aspect_ratio: input.aspectRatio, output_format: "mp4", generate_audio: false };
}

export function validateStatusUrl(raw: unknown, id: string): string {
  if (typeof raw !== "string" || !UUID.test(id) || raw !== `${API}/requests/${id}/status`) throw new GenerationError("provider_invalid_receipt");
  return raw;
}
export function validateOutputUrl(raw: unknown, allowedHosts: readonly string[]): string {
  if (typeof raw !== "string" || raw.length > 8000 || /[\s\\]/.test(raw)) throw new GenerationError("provider_invalid_output");
  let url: URL;
  try { url = new URL(raw); } catch { throw new GenerationError("provider_invalid_output"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !allowedHosts.includes(url.hostname)) {
    throw new GenerationError("provider_output_host_refused");
  }
  return url.href;
}

/** Deadline covers fetch AND streaming body; errors never echo prompts, URLs or secrets. */
export async function boundedResponse(url: string, init: RequestInit, maxBytes: number, timeoutMs: number, transport: typeof fetch = fetch): Promise<{ bytes: Buffer; mime: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let rejectAbort = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new GenerationError("provider_timeout", true)); });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    const options = { ...init, redirect: "error" as const, credentials: "omit" as const, cache: "no-store" as const, signal: controller.signal };
    response = await Promise.race([transport(url, options), aborted]);
    if (response.redirected || response.url && response.url !== url) throw new GenerationError("provider_redirect_refused");
    if (!response.ok) throw new GenerationError(`provider_http_${response.status}`, [408, 423, 429].includes(response.status) || response.status >= 500);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new GenerationError("provider_response_limit");
    if (!response.body) throw new GenerationError("provider_empty_response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new GenerationError("provider_response_limit");
      chunks.push(next.value);
    }
    if (!size) throw new GenerationError("provider_empty_response");
    return { bytes: Buffer.concat(chunks), mime: response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "" };
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError("provider_transport_failed", true);
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener("abort", rejectAbort);
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
    controller.abort();
  }
}

export class HiggsfieldProvider {
  constructor(private readonly env: Env = process.env, private readonly transport: typeof fetch = fetch) {}
  private async json(url: string, method: string, body?: unknown, idempotencyKey?: string): Promise<any> {
    const config = configuration(this.env);
    if (!config.ready) throw new GenerationError("provider_not_configured");
    const headers: Record<string, string> = { Authorization: `Key ${config.credentials}`, Accept: "application/json" };
    if (body !== undefined) { headers["Content-Type"] = "application/json"; headers["Hf-Expires-After"] = "10800"; }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const result = await boundedResponse(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 65536, 15000, this.transport);
    if (result.mime !== "application/json") throw new GenerationError("provider_invalid_json");
    try { return JSON.parse(result.bytes.toString("utf8")); } catch { throw new GenerationError("provider_invalid_json"); }
  }
  async submit(idempotencyKey: string, kind: GenerationKind, body: Record<string, unknown>, model = models[kind]?.id): Promise<ProviderReceipt> {
    if (!UUID.test(idempotencyKey) || !models[kind] || !approvedProviderModel("higgsfield", models[kind].baseline, model)) throw new GenerationError("provider_invalid_request");
    const webhook = `${configuration(this.env).webhookBase}/api/media/generation/webhook/${idempotencyKey}`;
    const reply = await this.json(`${API}/${model}?hf_webhook=${encodeURIComponent(webhook)}`, "POST", body, idempotencyKey);
    if (typeof reply?.request_id !== "string" || !UUID.test(reply.request_id)) throw new GenerationError("provider_invalid_receipt");
    return { requestId: reply.request_id, statusUrl: validateStatusUrl(reply.status_url, reply.request_id) };
  }
  async status(receipt: ProviderReceipt, kind: GenerationKind): Promise<ProviderStatus> {
    const reply = await this.json(validateStatusUrl(receipt.statusUrl, receipt.requestId), "GET");
    if (reply?.request_id !== receipt.requestId || !["queued", "in_progress", "completed", "failed", "nsfw", "canceled"].includes(reply?.status)) throw new GenerationError("provider_invalid_status");
    if (reply.status !== "completed") return { state: reply.status };
    const raw = kind === "image" ? (reply.images?.length === 1 ? reply.images[0]?.url : null) : reply.video?.url;
    return { state: "completed", outputUrl: validateOutputUrl(raw, configuration(this.env).outputHosts) };
  }
  async remove(receipt: ProviderReceipt): Promise<void> {
    validateStatusUrl(receipt.statusUrl, receipt.requestId);
    try { await this.json(`${API}/requests/${receipt.requestId}`, "DELETE"); }
    catch (error) { if (!(error instanceof GenerationError && error.code === "provider_http_404")) throw error; }
  }
  async download(url: string, kind: GenerationKind) {
    return boundedResponse(validateOutputUrl(url, configuration(this.env).outputHosts), { method: "GET", headers: { "Accept-Encoding": "identity" } }, kind === "image" ? 20 * 1024 * 1024 : 80 * 1024 * 1024, 45000, this.transport);
  }
}
