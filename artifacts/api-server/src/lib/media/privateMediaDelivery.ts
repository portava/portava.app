import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { once } from "node:events";
import { authorizeMediaAccess } from "../mediaAccess.js";
import { MEDIA_SIZE_LIMITS } from "../mediaPipeline.js";
import { sendError } from "../http.js";

export type MediaImageTransform = { width?: number; quality?: number };

type DeliveryOptions = {
  fetch?: typeof fetch;
  /** Bounded operation deadlines; overrides are for deterministic tests. */
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Optional presentation mask, evaluated only after current permission. */
  onAuthorized?: () => Promise<boolean>;
};

type ByteRange = { first: number | null; last: number | null };
async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Media request aborted");
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Media request aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}
function byteRange(value: string | undefined): ByteRange | null | false {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return false;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)
    || first === null && last === 0 || first !== null && last !== null && last < first) return false;
  return { first, last };
}

function storageRequest(bucket: string, path: string, transform?: MediaImageTransform): URL | null {
  if (!["post-media", "profile-media"].includes(bucket) || !path || path.length > 4096
    || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) return null;
  try {
    const base = new URL(process.env.SUPABASE_URL ?? "");
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/"
      || base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) return null;
    const parts = [bucket, ...path.split("/")].map(encodeURIComponent).join("/");
    const transformed = transform && (transform.width !== undefined || transform.quality !== undefined);
    const url = new URL(`/storage/v1/${transformed ? "render/image/authenticated" : "object"}/${parts}`, base);
    if (transformed) {
      // The route normalizes its user-facing controls. Reject an invalid
      // internal call rather than silently request a different representation.
      if (transform.width !== undefined) {
        if (!Number.isInteger(transform.width) || transform.width < 1 || transform.width > 3000) return null;
        url.searchParams.set("width", String(transform.width));
      }
      if (transform.quality !== undefined) {
        if (!Number.isInteger(transform.quality) || transform.quality < 1 || transform.quality > 100) return null;
        url.searchParams.set("quality", String(transform.quality));
      }
      url.searchParams.set("resize", "contain");
    }
    return url;
  } catch { return null; }
}

function safeContentType(raw: string | null): string {
  const type = raw?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^(?:image\/(?:avif|bmp|gif|heic|heif|jpeg|png|tiff|webp)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)$/.test(type)
    ? type : "application/octet-stream";
}

/**
 * The byte transport for mediaFile's coordinated authenticated-delivery cutover.
 * Never returns a provider URL. The caller supplies an authenticated viewer;
 * current account/source permission is checked here on every GET or HEAD.
 * Storage uses the existing configured service identity, with no redirects,
 * caller credentials, conditional cache validators, or upstream error bodies
 * forwarded to clients. Reads and writes are streamed with backpressure.
 *
 * Native consumers carry headers; browser AV uses the media-only same-origin
 * cookie adapter. There is no alternate byte endpoint.
 */
export async function deliverPrivateMedia(
  req: Request, res: Response, sc: SupabaseClient, viewerId: string,
  bucket: string, path: string, transform?: MediaImageTransform, options: DeliveryOptions = {},
): Promise<void> {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Authorization, Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (req.method !== "GET" && req.method !== "HEAD") { res.sendStatus(405); return; }
  const url = storageRequest(bucket, path, transform);
  if (!url || !viewerId) { res.sendStatus(400); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(abort, options.idleTimeoutMs ?? 30_000);
    idleTimer.unref();
  };
  const totalTimer = setTimeout(abort, options.totalTimeoutMs ?? 600_000);
  totalTimer.unref();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    touch();
    if (!await untilAborted(authorizeMediaAccess(sc, viewerId, bucket, path), controller.signal)) { sendError(res, "forbidden", "Not authorized for this media"); return; }
    if (options.onAuthorized && !await untilAborted(options.onAuthorized(), controller.signal)) return;
    if (controller.signal.aborted || req.aborted || res.destroyed) return;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) { res.sendStatus(503); return; }
    const requestedRange = req.method === "HEAD" ? null : byteRange(req.headers.range);
    if (requestedRange === false) { res.sendStatus(416); return; }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`, apikey: key, "Accept-Encoding": "identity",
      "Cache-Control": "no-store",
    };
    if (requestedRange) {
      headers.Range = req.headers.range!;
      const ifRange = req.headers["if-range"];
      if (typeof ifRange === "string" && ifRange.length <= 256 && !/[\u0000-\u001f\u007f]/.test(ifRange)) headers["If-Range"] = ifRange;
    }
    touch();
    // Our server's Node fetch declaration omits cache even though the runtime
    // accepts the standard option. Keep it explicitly typed, not a type bypass.
    const init: RequestInit & { cache: "no-store" } = {
      method: req.method, headers, signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store",
    };
    const upstream = await untilAborted((options.fetch ?? fetch)(url, init).then(response => {
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Media request aborted");
      }
      return response;
    }), controller.signal);
    reader = upstream.body?.getReader();
    if (controller.signal.aborted || res.destroyed) return;
    const reject = (status: number) => { res.sendStatus(status); };
    if (upstream.status === 404) { reject(404); return; }
    if (upstream.status === 416) {
      const total = /^bytes \*\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "");
      if (requestedRange && total && Number.isSafeInteger(Number(total[1]))) {
        res.setHeader("Content-Range", `bytes */${total[1]}`); reject(416);
      } else reject(502);
      return;
    }
    if (upstream.status !== 200 && upstream.status !== 206) { reject(502); return; }
    if (upstream.headers.get("content-encoding") && upstream.headers.get("content-encoding") !== "identity") { reject(502); return; }
    const rawLength = upstream.headers.get("content-length");
    let expectedLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    if (rawLength !== null && (expectedLength === null || !Number.isSafeInteger(expectedLength) || expectedLength > MEDIA_SIZE_LIMITS.video)) { reject(502); return; }
    if (upstream.status === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "");
      if (!requestedRange || !match) { reject(502); return; }
      const [first, last, total] = match.slice(1).map(Number) as [number, number, number];
      const expectedFirst = requestedRange.first ?? Math.max(0, total - requestedRange.last!);
      const expectedLast = requestedRange.first === null || requestedRange.last === null ? total - 1 : Math.min(total - 1, requestedRange.last);
      if (![first, last, total].every(Number.isSafeInteger) || first !== expectedFirst || last !== expectedLast
        || last < first || last >= total || total > MEDIA_SIZE_LIMITS.video
        || expectedLength !== null && expectedLength !== last - first + 1) { reject(502); return; }
      expectedLength = last - first + 1;
      res.setHeader("Content-Range", `bytes ${first}-${last}/${total}`);
    }
    res.status(upstream.status);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", safeContentType(upstream.headers.get("content-type")));
    if (expectedLength !== null) res.setHeader("Content-Length", expectedLength);
    if (req.method === "HEAD") { res.end(); return; }
    if (!reader) { if (expectedLength === 0) res.end(); else reject(502); return; }
    let received = 0;
    while (!controller.signal.aborted && !res.destroyed) {
      touch();
      const { done, value } = await untilAborted(reader.read(), controller.signal);
      if (controller.signal.aborted || res.destroyed) return;
      if (done) break;
      received += value.byteLength;
      if (received > MEDIA_SIZE_LIMITS.video || expectedLength !== null && received > expectedLength) throw new Error("Invalid media length");
      if (!res.write(value)) { touch(); await once(res, "drain", { signal: controller.signal }); }
    }
    if (controller.signal.aborted || res.destroyed) return;
    if (expectedLength !== null && received !== expectedLength) throw new Error("Incomplete media");
    res.end();
  } catch {
    // Provider diagnostics may contain signed locations or credentials. Emit
    // only our fixed response and terminate any already-started representation.
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else { res.removeHeader("Content-Length"); res.removeHeader("Content-Range"); res.sendStatus(502); }
    }
  } finally {
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    abort();
    void reader?.cancel().catch(() => {});
    req.removeListener("aborted", abort); res.removeListener("close", abort);
  }
}
