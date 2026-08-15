#!/usr/bin/env node
/**
 * dev-same-origin-proxy.mjs — DEV ONLY. Never runs in production. See the
 * INERTNESS section below, and `check-dev-proxy-not-shipped.mjs`, which fails
 * CI if this file ever becomes reachable from shipped code.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Phase B3 probe needs a browser exercising Discovery against the
 * PRODUCTION api-server. There is no deployed frontend, so the frontend runs
 * locally — and a local frontend talking straight to production is a
 * CROSS-ORIGIN request.
 *
 * Measured against production 2026-08-15:
 *
 *   *.kirk.replit.dev  ->  200, ACAO echoed
 *   http://localhost:* ->  HTTP 500, no ACAO   <-- every request fails
 *   no Origin header   ->  200
 *
 * The obvious fix — add the dev origin to ALLOWED_ORIGINS — was REFUSED, and
 * the reason matters more than the fix. Production already auto-allows ANY
 * subdomain of the multi-tenant parent `kirk.replit.dev` with
 * `credentials: true` (see docs/security/cors-dev-domain-allowlist-in-production.md).
 * Widening an already over-permissive production allowlist to make a test
 * convenient is the wrong direction on a policy that needs tightening.
 *
 * **No live production config change for a measurement.**
 *
 * WHAT IT DOES
 * ------------
 * One local origin. The browser talks to this proxy and nothing else:
 *
 *   browser ──same-origin──> this proxy ──server-to-server──> production API
 *                                  │
 *                                  └──────────────────────> Metro dev server
 *
 * `/api/*` is forwarded to the API target; everything else (including the HMR
 * websocket) goes to Metro. Because the forward is server-to-server, it carries
 * NO `Origin` header — the case production already allows. Nothing on the
 * server changes.
 *
 * The client cooperates without modification: every call site reads
 * `process.env.EXPO_PUBLIC_API_BASE_URL ?? ''`, so setting it EMPTY makes the
 * app issue same-origin RELATIVE requests (`/api/...`) that land here.
 *
 * INERTNESS — how this is GUARANTEED, not asserted
 * ------------------------------------------------
 * Four independent mechanisms, any one of which is sufficient:
 *
 *   1. NOT IN THE BUNDLE, STRUCTURALLY. This is a standalone Node script under
 *      `scripts/`. It is not imported by `src/`, `app/`, or `server/`, and it is
 *      not referenced from `metro.config.js` or `babel.config.js`, so it is not
 *      in the Metro module graph and cannot be bundled. It is not wired into
 *      Metro at all — no `enhanceMiddleware`, no config hook.
 *   2. ENFORCED BY A GUARD, NOT BY CONVENTION. `check-dev-proxy-not-shipped.mjs`
 *      fails CI if any file under `src/`, `app/`, or `server/`, or either build
 *      config, references this module. Point 1 stops being a promise and starts
 *      being a test.
 *   3. NOT REACHABLE BY THE PRODUCTION SERVE PATH. Production web is a static
 *      export served by `server/serve.js`. Metro is not running and no npm
 *      script in the production path invokes this file. It only runs when a
 *      human types it.
 *   4. IT REFUSES TO RUN ANYWAY. Fails closed on `NODE_ENV=production`, and
 *      requires `--api` to be passed explicitly — there is no default target, so
 *      it cannot silently point at production. Both refusals are below and both
 *      exit non-zero.
 *
 * Mechanism 4 alone would be an assertion. 1–3 are what make it structural; 4 is
 * the belt to that pair of braces.
 *
 * USAGE
 * -----
 *   # terminal 1 — Metro, with the API base EMPTY so the app uses relative URLs
 *   cd travel-buddy-standalone
 *   EXPO_PUBLIC_API_BASE_URL= pnpm exec expo start --web --port 8081
 *
 *   # terminal 2 — this proxy
 *   node scripts/dev-same-origin-proxy.mjs \
 *     --api https://portava.replit.app --metro http://127.0.0.1:8081 --port 8090
 *
 * Then open the app on the proxy's port. Every `/api/*` call is logged with
 * method, path and upstream status — a client-side audit trail to set beside
 * the server-side row counts.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// ── Refusal 1: never in production ───────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  console.error(
    "REFUSING: NODE_ENV=production. This is a development-only proxy for the " +
      "Phase B3 probe and has no production use. If you are seeing this in a " +
      "deployed environment, something is wrong with the deployment, not with " +
      "this flag.",
  );
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

const API_TARGET = arg("api");
const METRO_TARGET = arg("metro") ?? "http://127.0.0.1:8081";
const PORT = Number(arg("port") ?? 8090);

// ── Refusal 2: no default API target ─────────────────────────────────────────
// Deliberately has no default. A default pointing at production is how a tool
// ends up talking to production because nobody passed a flag.
if (!API_TARGET) {
  console.error(
    "REFUSING: --api is required and has no default.\n\n" +
      "  node scripts/dev-same-origin-proxy.mjs --api https://portava.replit.app\n\n" +
      "There is no default on purpose: a default pointing at production is how a " +
      "tool ends up talking to production because nobody passed a flag.",
  );
  process.exit(2);
}

let apiUrl;
try {
  apiUrl = new URL(API_TARGET);
} catch {
  console.error(`REFUSING: --api ${JSON.stringify(API_TARGET)} is not a valid URL.`);
  process.exit(2);
}
const metroUrl = new URL(METRO_TARGET);

/**
 * Headers that must NOT be forwarded upstream to the API.
 *
 * `origin` and `referer` are the point of the whole exercise: stripping them
 * makes the forward a server-to-server request, which is the case production
 * already permits. Forwarding them would recreate exactly the cross-origin
 * rejection this proxy exists to avoid — and it would do so invisibly, as a
 * 500 rather than a CORS error.
 *
 * `host` is replaced with the upstream host. `connection` and friends are
 * hop-by-hop and must not be relayed.
 */
const STRIP_UPSTREAM = new Set([
  "origin",
  "referer",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardHeaders(headers, upstreamHost) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIP_UPSTREAM.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = upstreamHost;
  return out;
}

const server = http.createServer((req, res) => {
  const isApi = req.url === "/api" || req.url.startsWith("/api/");
  const target = isApi ? apiUrl : metroUrl;
  const client = target.protocol === "https:" ? https : http;

  const upstreamPath = isApi
    ? target.pathname.replace(/\/$/, "") + req.url
    : req.url;

  const started = Date.now();
  const proxyReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers: forwardHeaders(req.headers, target.host),
    },
    (proxyRes) => {
      if (isApi) {
        // Audit trail for the probe. Never logs header VALUES — an
        // Authorization bearer token would otherwise land in a terminal
        // scrollback and from there into a pasted report.
        const ms = Date.now() - started;
        console.log(
          `[api] ${req.method} ${req.url.split("?")[0]} -> ${proxyRes.statusCode} (${ms}ms)`,
        );
      }
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    const where = isApi ? `API ${apiUrl.origin}` : `Metro ${metroUrl.origin}`;
    console.error(`[proxy] ${req.method} ${req.url} -> ${where} FAILED: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error contacting ${where}: ${err.message}`);
  });

  req.pipe(proxyReq);
});

// Metro's HMR runs over a websocket. Without relaying the upgrade the app still
// loads, but the console fills with reconnect failures that read like app
// errors — noise an observer would have to triage mid-probe.
server.on("upgrade", (req, socket, head) => {
  const proxyReq = http.request({
    hostname: metroUrl.hostname,
    port: metroUrl.port || 80,
    method: req.method,
    path: req.url,
    headers: req.headers,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (proxyHead?.length) proxySocket.unshift(proxyHead);
    proxySocket.pipe(socket).pipe(proxySocket);
  });

  proxyReq.on("error", () => socket.destroy());
  if (head?.length) proxyReq.write(head);
  proxyReq.end();
});

server.listen(PORT, () => {
  console.log("─".repeat(72));
  console.log("DEV same-origin proxy — development only, not a production path");
  console.log("─".repeat(72));
  console.log(`  listening   http://localhost:${PORT}`);
  console.log(`  /api/*   ->  ${apiUrl.origin}   (server-to-server, Origin stripped)`);
  console.log(`  else     ->  ${metroUrl.origin}   (Metro dev server)`);
  console.log("");
  console.log(`  Open the app at http://localhost:${PORT} — NOT at ${metroUrl.origin},`);
  console.log("  or the browser will talk to Metro directly and /api will 404.");
  console.log("");
  console.log("  Start Metro with EXPO_PUBLIC_API_BASE_URL EMPTY so the app issues");
  console.log("  same-origin relative /api requests that land here.");
  if (apiUrl.hostname.includes("portava.replit.app")) {
    console.log("");
    console.log("  ⚠ API target is PRODUCTION. Requests will hit the production");
    console.log("    database and write real rows. That is intended for the B3 probe.");
  }
  console.log("─".repeat(72));
});
