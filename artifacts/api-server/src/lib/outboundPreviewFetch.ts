/**
 * The controlled outbound fetch behind Telegraph link previews (§30A.8, census
 * T404 / T446; migration 3825; flag `telegraph_link_previews_enabled`, seeded
 * FALSE). The ONLY code in the server that connects to a host a person typed.
 *
 * PROVENANCE. The fetch core — `normalizePreviewUrl`, the pinned-address
 * transport, per-hop redirect re-validation, the size / time / type caps,
 * `parsePreview` and the short per-URL cache — is the uncommitted Codex T404
 * work's `lib/linkPreview.ts` (`/Users/areyouok/portava-sandbox/wt-codex-t404`),
 * copied under lead ruling LR-B58-3 with its tests
 * (`src/test/telegraphLinkPreviewFetch.test.ts` A1–A3). What was hardened on
 * adoption, each a plan default (b58/PLAN-telegraph-media.md §2 TM-1, §4):
 *   - https ONLY (Q-LP7). Codex allowed `http:` on port 80.
 *   - A redirect may only stay on the ORIGINAL host or its `www.` twin (Q-LP8).
 *     The plan says "registrable domain"; that needs a public-suffix list this
 *     tree does not carry, so the stricter same-host rule is used — a link
 *     shortener's hop to another site is no preview, which is the point: the
 *     host the recipient is shown is the host the preview describes.
 *   - The preview always names the ORIGINAL url and host, never the final one.
 *   - A Portava User-Agent; no cookie, credential, pool or keep-alive.
 *   - The pinned `lookup` answers BOTH callback shapes (single and `all`), so
 *     Node's multi-address connect path can never fall back to a fresh DNS
 *     answer; Codex relied on `family` alone to keep that path closed.
 *   - A process-wide in-flight gate (`OutboundFetchGate`): a global ceiling,
 *     a per-person ceiling and a per-host ceiling. Codex had only a per-person
 *     rate, so the server was a general fetcher with no total bound.
 * WHO CALLS IT. Only `routes/telegraphLinkPreview.ts`'s POST, which the SENDER
 * of a message makes at send time, for the first external URL in the stored
 * body. There is no endpoint that takes a URL from a client, and the read path
 * recipients use never reaches this module (it reads stored rows only).
 *
 * WHAT IT RETURNS. Text only: title, description, site name, the original url
 * and host. No image field exists in the type, so an image URL chosen by the
 * page cannot travel to a recipient's device (Q-LP5).
 *
 * SSRF. Every hop: the URL is re-normalised (https, no userinfo, no port other
 * than 443, no IP literal in any spelling the URL parser accepts, no reserved
 * suffix), every DNS answer must be globally routable
 * (`lib/outboundAddressPolicy.ts`), and the socket connects to the VETTED
 * address — the pinned lookup cannot return anything else — so a resolver that
 * answers differently between the check and the connect (DNS rebinding) is
 * never consulted a second time. TLS SNI and certificate verification keep the
 * hostname.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import { isPublicPreviewAddress } from "./outboundAddressPolicy.js";

export const PREVIEW_MAX_BYTES = 256 * 1024;
export const PREVIEW_TIMEOUT_MS = 4000;
export const PREVIEW_MAX_REDIRECTS = 3;
export const PREVIEW_USER_AGENT = "PortavaLinkPreview/1.0 (+https://portava.app)";
/** Field caps, mirrored by migration 3825's CHECK constraints. */
export const PREVIEW_TITLE_MAX = 200;
export const PREVIEW_DESCRIPTION_MAX = 500;
export const PREVIEW_SITE_NAME_MAX = 100;
export const PREVIEW_URL_MAX = 2048;
export const PREVIEW_HOST_MAX = 253;

export type LinkPreview = { url: string; host: string; title: string; description: string; siteName: string };
export type PreviewResult = { kind: "preview"; preview: LinkPreview } | { kind: "no_preview" };
const NONE: PreviewResult = { kind: "no_preview" };

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const RESERVED_SUFFIX = /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|test|invalid|arpa|onion)$/i;

/**
 * The URL in the one shape this module will fetch, or a throw. https only, no
 * userinfo, default port only, a dotted DNS name (never an IP literal — the URL
 * parser has already folded decimal / octal / hex IPv4 spellings into a
 * dotted quad, which `isIP` then refuses), no reserved suffix, fragment dropped.
 */
export function normalizePreviewUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length > PREVIEW_URL_MAX || /[\u0000- \u007f]/u.test(raw)) throw new Error("URL");
  const url = new URL(raw);
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      isIP(host) || host.includes(":") || !host.includes(".") || RESERVED_SUFFIX.test(host) ||
      !/^[a-z0-9.-]+$/.test(host) || host.split(".").some((label) => label.length === 0 || label.length > 63) ||
      /^[0-9.]+$/.test(host)) throw new Error("URL");
  url.hostname = host;
  url.hash = "";
  if (url.href.length > PREVIEW_URL_MAX || host.length > PREVIEW_HOST_MAX) throw new Error("URL length");
  return url;
}

/** Q-LP8: a redirect may stay on the original host or move between it and its `www.` twin, nothing else. */
export function sameSiteHost(original: string, next: string): boolean {
  const bare = (h: string) => (h.startsWith("www.") ? h.slice(4) : h);
  return original === next || bare(original) === bare(next);
}

type Hop = { status: number; location?: string; body: string };
export type ResolvedAddress = { address: string; family: number };
export type PreviewNetwork = {
  resolve: (host: string) => Promise<ResolvedAddress[]>;
  request: (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<Hop>;
};

/**
 * A `lookup` that can only ever answer the vetted address, in either callback
 * shape Node uses (`all: true` for the multi-address connect path).
 */
export function pinnedLookup(address: ResolvedAddress) {
  return (_host: string, options: unknown, callback?: (...args: unknown[]) => void) => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
}

export const previewNetwork: PreviewNetwork = {
  resolve: (host) => lookup(host, { all: true, verbatim: true }),
  request: (url, address, signal) => new Promise((resolve, reject) => {
    if (url.protocol !== "https:") { reject(new Error("protocol")); return; }
    const req = https.request(url, {
      agent: false, family: address.family, signal,
      headers: { Accept: "text/html", "Accept-Encoding": "identity", "User-Agent": PREVIEW_USER_AGENT },
      lookup: pinnedLookup(address) as never,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (REDIRECT.has(status)) {
        res.destroy(); resolve({ status, location: res.headers.location, body: "" }); return;
      }
      if (status !== 200 || !/^text\/html(?:\s*;|\s*$)/i.test(res.headers["content-type"] ?? "") ||
          (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") ||
          Number(res.headers["content-length"] ?? 0) > PREVIEW_MAX_BYTES) {
        res.destroy(); reject(new Error("response")); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PREVIEW_MAX_BYTES) { res.destroy(new Error("size")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("aborted")));
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  }),
};

function clean(raw: string, max: number): string {
  return raw.replace(/&#(x[0-9a-f]+|\d+);|&(amp|quot|apos|lt|gt|nbsp);/gi, (all, num, name) => {
    if (num) { const n = num[0].toLowerCase() === "x" ? parseInt(num.slice(1), 16) : Number(num); return n <= 0x10ffff ? String.fromCodePoint(n) : ""; }
    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " } as Record<string, string>)[name.toLowerCase()] ?? all;
  }).replace(/<[^>]*>/g, "").replace(/[<>]/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Inert extraction of the text fields. Scripts, styles, comments and the tags
 * inside them are removed before any `<meta>` is read. `url` / `host` are the
 * ORIGINAL link's, never the page's or the final hop's.
 */
export function parsePreview(html: string, original: URL): LinkPreview {
  const source = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const meta = new Map<string, string>();
  for (const tag of source.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const a of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4];
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (!meta.has(key)) meta.set(key, attrs.content ?? "");
  }
  return {
    url: original.href, host: clean(original.hostname, PREVIEW_HOST_MAX),
    title: clean(meta.get("og:title") || meta.get("twitter:title") || source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "", PREVIEW_TITLE_MAX),
    description: clean(meta.get("og:description") || meta.get("twitter:description") || meta.get("description") || "", PREVIEW_DESCRIPTION_MAX),
    siteName: clean(meta.get("og:site_name") || meta.get("twitter:site") || "", PREVIEW_SITE_NAME_MAX),
  };
}

export type PreviewService = (raw: string) => Promise<PreviewResult>;

/**
 * The fetch, with its total deadline and a short per-URL memo (60 s, 500
 * entries) so the same link sent into several threads at once is fetched once.
 */
export function createPreviewService(network: PreviewNetwork = previewNetwork, timeoutMs = PREVIEW_TIMEOUT_MS): PreviewService {
  const cache = new Map<string, { expires: number; result: PreviewResult }>();
  return async (raw: string): Promise<PreviewResult> => {
    let url: URL;
    try { url = normalizePreviewUrl(raw); } catch { return NONE; }
    const original = new URL(url.href);
    const key = url.href;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<PreviewResult>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(NONE); }, timeoutMs);
    });
    const work = async (): Promise<PreviewResult> => {
      for (let hop = 0; hop <= PREVIEW_MAX_REDIRECTS; hop++) {
        const addresses = await network.resolve(url.hostname);
        if (controller.signal.aborted || !addresses.length || addresses.some((a) => !isPublicPreviewAddress(a.address))) return NONE;
        const response = await network.request(url, addresses[0]!, controller.signal);
        if (controller.signal.aborted) return NONE;
        if (REDIRECT.has(response.status)) {
          if (!response.location || hop === PREVIEW_MAX_REDIRECTS) return NONE;
          url = normalizePreviewUrl(new URL(response.location, url).href);
          if (!sameSiteHost(original.hostname, url.hostname)) return NONE;
          continue;
        }
        if (response.status !== 200 || Buffer.byteLength(response.body) > PREVIEW_MAX_BYTES) return NONE;
        return { kind: "preview", preview: parsePreview(response.body, original) };
      }
      return NONE;
    };
    const result = await Promise.race([work().catch(() => NONE), deadline]);
    clearTimeout(timer!);
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 60_000, result });
    return result;
  };
}

export type GateRefusal = "global" | "user" | "host";
export type GateTicket = { ok: true; release: () => void } | { ok: false; refusal: GateRefusal };

/**
 * The process-wide in-flight ceiling on outbound preview fetches. A ticket is
 * taken BEFORE any DNS or socket work and released when the fetch settles; a
 * refusal is an answer ("busy"), never a queued fetch. Three ceilings, because
 * each closes a different abuse: the global one bounds the server as a fetcher
 * at all; the per-person one stops one account occupying it; the per-host one
 * stops Portava being pointed at one site by many accounts at once.
 */
export class OutboundFetchGate {
  private inFlight = 0;
  private readonly byUser = new Map<string, number>();
  private readonly byHost = new Map<string, number>();
  constructor(readonly limits: { global: number; perUser: number; perHost: number } = { global: 8, perUser: 2, perHost: 2 }) {}

  tryAcquire(userId: string, host: string): GateTicket {
    if (this.inFlight >= this.limits.global) return { ok: false, refusal: "global" };
    if ((this.byUser.get(userId) ?? 0) >= this.limits.perUser) return { ok: false, refusal: "user" };
    if ((this.byHost.get(host) ?? 0) >= this.limits.perHost) return { ok: false, refusal: "host" };
    this.inFlight += 1;
    this.byUser.set(userId, (this.byUser.get(userId) ?? 0) + 1);
    this.byHost.set(host, (this.byHost.get(host) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
        const u = (this.byUser.get(userId) ?? 1) - 1;
        if (u > 0) this.byUser.set(userId, u); else this.byUser.delete(userId);
        const h = (this.byHost.get(host) ?? 1) - 1;
        if (h > 0) this.byHost.set(host, h); else this.byHost.delete(host);
      },
    };
  }

  /** In-flight count, for tests and diagnostics. */
  get active(): number { return this.inFlight; }
}
