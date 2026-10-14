/**
 * census-telegraph T404 / T446 (B58 TM-1) — the controlled outbound fetch
 * (`lib/outboundPreviewFetch.ts`) and the address policy
 * (`lib/outboundAddressPolicy.ts`).
 *
 * A1–A3 are the Codex T404 work's fetch-core tests
 * (`wt-codex-t404/artifacts/api-server/src/test/telegraphLinkPreview.test.ts`),
 * carried over under lead ruling LR-B58-3 and changed only where adoption
 * hardened the core: https only (Q-LP7), so their `http://` probes are now
 * refused for that reason too and the public fixtures are `https://`; and the
 * preview names the ORIGINAL link. S1–S9 are the SSRF cases the B58 brief asks
 * for on top: every private range, DNS rebinding between check and connect,
 * redirects, IPv6, decimal / octal / hex IPv4 spellings, userinfo tricks. G1–G3
 * are the in-flight gate.
 *
 * No socket and no DNS query is made: DNS and HTTP are substituted, and the
 * REAL transport is exercised against in-memory request/response doubles.
 *
 * Run: node --import tsx/esm --test src/test/telegraphLinkPreviewFetch.test.ts
 */
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import {
  createPreviewService,
  normalizePreviewUrl,
  OutboundFetchGate,
  pinnedLookup,
  previewNetwork,
  sameSiteHost,
  PREVIEW_MAX_BYTES,
  PREVIEW_USER_AGENT,
  type PreviewNetwork,
} from "../lib/outboundPreviewFetch.js";
import { isPublicPreviewAddress } from "../lib/outboundAddressPolicy.js";

const publicAddress = { address: "93.184.216.34", family: 4 };
function fixture(body = "<title>Fallback</title>") {
  const requests: string[] = [];
  const network: PreviewNetwork = {
    resolve: async (_host: string) => [publicAddress],
    request: async (url: URL, address: { address: string; family: number }, _signal: AbortSignal) => {
      assert.deepEqual(address, publicAddress); requests.push(url.href); return { status: 200, body };
    },
  };
  return { network, requests };
}
afterEach(() => { mock.restoreAll(); });

// ── A1–A3: adopted from the Codex T404 work ──────────────────────────────────

test("A1 sanitized OG-only text, bounded fields, normalized cache; no images or HTML", async () => {
  const { network, requests } = fixture(`<script><meta property="og:title" content="wrong"></script>
    <title>Fallback</title><meta property="og:title" content="Hi &amp; &lt;b&gt;there&lt;/b&gt;‮​\u0001">
    <meta property="og:description" content="${"D".repeat(600)}"><meta property="og:site_name" content="Site⁦">
    <meta property="og:image" content="https://tracker.example/image">`);
  const service = createPreviewService(network);
  const result = await service("https://PUBLIC.example:443/a#fragment");
  assert.deepEqual(result, { kind: "preview", preview: { url: "https://public.example/a", host: "public.example", title: "Hi & there", description: "D".repeat(500), siteName: "Site" } });
  assert.deepEqual(await service("https://public.example/a"), result);
  assert.equal(requests.length, 1);
  // Text only: nothing in the result can carry the page's image to a recipient.
  assert.equal(JSON.stringify(result).includes("tracker.example"), false);
});

test("A2 unsafe URL forms refused before requesting", async () => {
  for (const url of ["http://127.0.0.1", "http://10.1.2.3", "http://169.254.169.254", "http://[::1]", "http://[::ffff:127.0.0.1]", "https://public.example:8080", "https://user:pass@public.example", "ftp://public.example", "file:///etc/passwd", "javascript:alert(1)", "https://localhost", "https://x.localhost", "http://2130706433", "http://public.example"]) {
    const { network, requests } = fixture();
    assert.equal((await createPreviewService(network)(url)).kind, "no_preview", url);
    assert.equal(requests.length, 0, url);
  }
});

test("A2 nonpublic DNS answers (including mixed answers and IPv6) never connect", async () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "224.1.1.1", "255.255.255.255", "168.63.129.16", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "2002:7f00:1::"]) {
    const { network, requests } = fixture();
    network.resolve = async () => [publicAddress, { address, family: address.includes(":") ? 6 : 4 }];
    assert.equal((await createPreviewService(network)("https://public.example")).kind, "no_preview", address);
    assert.equal(requests.length, 0, address);
    assert.equal(isPublicPreviewAddress(address), false, address);
  }
  assert.equal(isPublicPreviewAddress("2606:4700:4700::1111"), true);
});

test("A2 redirects revalidate URL and DNS, and stop after three redirects", async () => {
  for (const location of ["http://127.0.0.1", "https://private.example", "https://public.example/again"]) {
    const { network, requests } = fixture();
    network.resolve = async (host) => host === "private.example" ? [{ address: "10.0.0.1", family: 4 }] : [publicAddress];
    network.request = async (url) => { requests.push(url.href); return { status: 302, location, body: "" }; };
    assert.equal((await createPreviewService(network)("https://public.example")).kind, "no_preview");
    assert.equal(requests.length, location.endsWith("/again") ? 4 : 1, location);
  }
});

// Exercise the REAL transport with in-memory IncomingMessage/ClientRequest
// doubles: no socket or DNS call is made by these tests.
function transport({ type = "text/html", body = "<title>Hello</title>", hang = false, length, status = 200, location }: { type?: string; body?: string; hang?: boolean; length?: number; status?: number; location?: string } = {}) {
  let destroyed = false;
  let options: any;
  let requestedUrl: URL;
  let calls = 0;
  const request = (_url: any, opts: any, callback: any) => {
    options = opts; requestedUrl = _url; calls++;
    const req = new EventEmitter() as any;
    req.end = () => {
      if (hang) return;
      const res = new EventEmitter() as any;
      res.statusCode = status;
      res.headers = { "content-type": type, ...(length ? { "content-length": String(length) } : {}), ...(location ? { location } : {}) };
      res.destroy = (error?: Error) => { destroyed = true; if (error) res.emit("error", error); };
      callback(res);
      if (!destroyed) res.emit("data", Buffer.from(body));
      if (!destroyed) res.emit("end");
    };
    opts.signal.addEventListener("abort", () => { destroyed = true; req.emit("error", new Error("abort")); });
    return req;
  };
  mock.method(https, "request", request);
  const service = createPreviewService({ resolve: async () => [publicAddress], request: previewNetwork.request }, 20);
  return { service, options: () => options, url: () => requestedUrl, destroyed: () => destroyed, calls: () => calls };
}

test("A2 transport pins vetted IP and keeps hostname/TLS identity", async () => {
  const t = transport();
  assert.equal((await t.service("https://public.example")).kind, "preview");
  t.options().lookup("public.example", {}, (error: any, address: string, family: number) => {
    assert.equal(error, null); assert.equal(address, publicAddress.address); assert.equal(family, 4);
  });
  assert.equal(t.options().agent, false);
  assert.equal(t.options().family, 4);
  assert.equal(t.url().hostname, "public.example");
});

test("A3 oversized streaming body and Content-Length yield no preview", async () => {
  for (const options of [{ body: "x".repeat(PREVIEW_MAX_BYTES + 1) }, { length: PREVIEW_MAX_BYTES + 1 }]) {
    const t = transport(options);
    assert.equal((await t.service("https://public.example")).kind, "no_preview");
    assert.equal(t.destroyed(), true);
  }
});

test("A3 non-HTML yields no preview", async () => {
  const t = transport({ type: "image/png" });
  assert.equal((await t.service("https://public.example")).kind, "no_preview");
  assert.equal(t.destroyed(), true);
});

test("A3 total deadline covers hung response and DNS; abort prevents late connect", async () => {
  const t = transport({ hang: true });
  assert.equal((await t.service("https://public.example")).kind, "no_preview");
  assert.equal(t.destroyed(), true);
  const f = fixture();
  let finish!: (value: typeof publicAddress[]) => void;
  f.network.resolve = () => new Promise((resolve) => { finish = resolve; });
  assert.equal((await createPreviewService(f.network, 10)("https://public.example")).kind, "no_preview");
  finish([publicAddress]); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
});

// ── S1–S9: the SSRF cases added on adoption ──────────────────────────────────

test("S1 every special-purpose IPv4 block is refused, at both edges, and public neighbours are allowed", () => {
  const blocks: Array<[string, string]> = [
    ["0.0.0.0", "0.255.255.255"], ["10.0.0.0", "10.255.255.255"], ["100.64.0.0", "100.127.255.255"],
    ["127.0.0.0", "127.255.255.255"], ["169.254.0.0", "169.254.255.255"], ["172.16.0.0", "172.31.255.255"],
    ["192.0.0.0", "192.0.0.255"], ["192.0.2.0", "192.0.2.255"], ["192.88.99.0", "192.88.99.255"],
    ["192.168.0.0", "192.168.255.255"], ["198.18.0.0", "198.19.255.255"], ["198.51.100.0", "198.51.100.255"],
    ["203.0.113.0", "203.0.113.255"], ["224.0.0.0", "239.255.255.255"], ["240.0.0.0", "255.255.255.255"],
    ["168.63.129.16", "168.63.129.16"], ["100.100.100.200", "192.0.0.192"],
  ];
  for (const [lo, hi] of blocks) {
    assert.equal(isPublicPreviewAddress(lo), false, lo);
    assert.equal(isPublicPreviewAddress(hi), false, hi);
  }
  for (const ok of ["1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "223.255.255.255", "93.184.216.34"]) {
    assert.equal(isPublicPreviewAddress(ok), true, ok);
  }
});

test("S2 IPv6: only global unicast outside its special blocks; mapped, NAT64, ULA, link-local, multicast, zoned all refused", () => {
  for (const bad of ["::", "::1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "64:ff9b::808:808", "64:ff9b:1::1", "fc00::1", "fd00:ec2::254", "fe80::1", "fec0::1", "ff02::1", "2001::1", "2001:0:4136:e378::1", "2001:db8::1", "2002:0a00:0001::1", "3fff::1", "fe80::1%eth0", "not-an-ip", ""]) {
    assert.equal(isPublicPreviewAddress(bad), false, bad);
  }
  for (const ok of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::1"]) {
    assert.equal(isPublicPreviewAddress(ok), true, ok);
  }
});

test("S3 IPv4 in every spelling the URL parser accepts — decimal, octal, hex, short — is an IP literal and refused", async () => {
  for (const raw of ["https://2130706433/", "https://0x7f000001/", "https://017700000001/", "https://0177.0.0.1/", "https://0x7f.0.0.1/", "https://127.1/", "https://127.0.0.1./", "https://3232235777/", "https://0xa9fea9fe/", "https://[::1]/", "https://[::ffff:7f00:1]/", "https://[2606:4700:4700::1111]/"]) {
    assert.throws(() => normalizePreviewUrl(raw), undefined, raw);
    const { network, requests } = fixture();
    assert.equal((await createPreviewService(network)(raw)).kind, "no_preview", raw);
    assert.equal(requests.length, 0, raw);
  }
});

test("S4 userinfo and authority tricks never reach a different host", async () => {
  // Each either throws or normalises to a host that is not the one the trick aimed at.
  for (const raw of ["https://public.example@127.0.0.1/", "https://public.example:@10.0.0.1/", "https://user:pass@public.example/", "https://user@public.example/", "https://127.0.0.1#@public.example/", "https://127.0.0.1?@public.example/"]) {
    assert.throws(() => normalizePreviewUrl(raw), undefined, raw);
  }
  // A backslash is a path separator for https: the host stays public.example.
  assert.equal(normalizePreviewUrl("https://public.example\\@127.0.0.1/").hostname, "public.example");
  for (const raw of ["https://localhost./", "https://LOCALHOST/", "https://metadata.google.internal/", "https://printer.local/", "https://intranet/", "https://router.lan/", "https://x.home.arpa/", "https://abc.onion/", "https://pub lic.example/", "https://public.example:80/", "https://public.example:8443/"]) {
    assert.throws(() => normalizePreviewUrl(raw), undefined, raw);
  }
  assert.equal(normalizePreviewUrl("https://xn--bcher-kva.example/a#x").href, "https://xn--bcher-kva.example/a");
  assert.equal(normalizePreviewUrl("https://bücher.example/").hostname, "xn--bcher-kva.example");
});

test("S5 DNS rebinding between check and connect: the socket can only reach the address that was vetted", async () => {
  // The resolver answers public on the check and private on any later query. The
  // transport must never ask again: its lookup is pinned to the vetted answer.
  let queries = 0;
  const resolve = async () => { queries++; return queries === 1 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 }]; };
  let options: any;
  mock.method(https, "request", (_url: any, opts: any, callback: any) => {
    options = opts;
    const req = new EventEmitter() as any;
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = 200; res.headers = { "content-type": "text/html" }; res.destroy = () => {};
      callback(res); res.emit("data", Buffer.from("<title>ok</title>")); res.emit("end");
    };
    return req;
  });
  const result = await createPreviewService({ resolve, request: previewNetwork.request }, 50)("https://rebind.example/");
  assert.equal(result.kind, "preview");
  assert.equal(queries, 1, "one DNS query per hop, made by the check");
  // Both callback shapes Node's connect path uses answer the vetted address only.
  const single: unknown[] = [];
  options.lookup("rebind.example", { family: 4 }, (...a: unknown[]) => single.push(...a));
  assert.deepEqual(single, [null, publicAddress.address, 4]);
  const all: unknown[] = [];
  options.lookup("rebind.example", { all: true }, (...a: unknown[]) => all.push(...a));
  assert.deepEqual(all, [null, [publicAddress]]);
  const noOpts: unknown[] = [];
  options.lookup("rebind.example", (...a: unknown[]) => noOpts.push(...a));
  assert.deepEqual(noOpts, [null, publicAddress.address, 4]);
  assert.equal(options.headers["User-Agent"], PREVIEW_USER_AGENT);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.headers.Authorization, undefined);
});

test("S5 pinnedLookup is the vetted address for IPv6 too", () => {
  const v6 = { address: "2606:4700:4700::1111", family: 6 };
  const out: unknown[] = [];
  pinnedLookup(v6)("x.example", { all: true }, (...a: unknown[]) => out.push(...a));
  assert.deepEqual(out, [null, [v6]]);
});

test("S6 a public IPv6 answer connects with family 6 to that address", async () => {
  const v6 = { address: "2606:4700:4700::1111", family: 6 };
  const seen: Array<{ address: string; family: number }> = [];
  const network: PreviewNetwork = {
    resolve: async () => [v6],
    request: async (_url, address) => { seen.push(address); return { status: 200, body: "<title>v6</title>" }; },
  };
  assert.equal((await createPreviewService(network)("https://v6.example/")).kind, "preview");
  assert.deepEqual(seen, [v6]);
});

test("S7 redirects (Q-LP8): same host or its www twin only; http, IP, private, cross-site and 4th hop refused", async () => {
  const cases: Array<{ location: string; ok: boolean }> = [
    { location: "/relative", ok: true },
    { location: "https://www.public.example/page", ok: true },
    { location: "https://public.example/other", ok: true },
    { location: "http://public.example/page", ok: false },
    { location: "https://93.184.216.34/", ok: false },
    { location: "https://evil.example/", ok: false },
    { location: "https://public.example.evil.example/", ok: false },
    { location: "https://sub.public.example/", ok: false },
    { location: "https://private.public.example/", ok: false },
  ];
  for (const { location, ok } of cases) {
    const requests: string[] = [];
    const network: PreviewNetwork = {
      resolve: async (host) => host.startsWith("private.") ? [{ address: "10.0.0.1", family: 4 }] : [publicAddress],
      request: async (url) => {
        requests.push(url.href);
        return requests.length === 1 ? { status: 301, location, body: "" } : { status: 200, body: "<title>Landed</title>" };
      },
    };
    const result = await createPreviewService(network)("https://public.example/start");
    assert.equal(result.kind, ok ? "preview" : "no_preview", location);
    assert.equal(requests.length, ok ? 2 : 1, location);
    // The preview names the ORIGINAL link, not where it landed.
    if (result.kind === "preview") assert.deepEqual([result.preview.url, result.preview.host], ["https://public.example/start", "public.example"]);
  }
  assert.equal(sameSiteHost("public.example", "www.public.example"), true);
  assert.equal(sameSiteHost("www.public.example", "public.example"), true);
  assert.equal(sameSiteHost("public.example", "evilpublic.example"), false);
});

test("S8 the real transport follows nothing itself: a 3xx is handed back, its body never read", async () => {
  const t = transport({ status: 302, location: "https://evil.example/", body: "<title>should not be read</title>" });
  assert.equal((await t.service("https://public.example/")).kind, "no_preview");
  assert.equal(t.calls(), 1);
  assert.equal(t.destroyed(), true);
});

test("S9 an empty DNS answer, a resolver error and a refused connection are each no preview", async () => {
  for (const network of [
    { resolve: async () => [], request: async () => ({ status: 200, body: "<title>x</title>" }) },
    { resolve: async () => { throw new Error("ENOTFOUND"); }, request: async () => ({ status: 200, body: "<title>x</title>" }) },
    { resolve: async () => [publicAddress], request: async () => { throw new Error("ECONNREFUSED"); } },
  ] as PreviewNetwork[]) {
    assert.equal((await createPreviewService(network)("https://public.example/")).kind, "no_preview");
  }
});

// ── G1–G3: the in-flight gate ────────────────────────────────────────────────

test("G1 the global ceiling refuses the next fetch and frees on release", () => {
  const gate = new OutboundFetchGate({ global: 2, perUser: 5, perHost: 5 });
  const a = gate.tryAcquire("u1", "a.example");
  const b = gate.tryAcquire("u2", "b.example");
  assert.ok(a.ok && b.ok);
  assert.deepEqual(gate.tryAcquire("u3", "c.example"), { ok: false, refusal: "global" });
  if (a.ok) { a.release(); a.release(); } // idempotent
  assert.equal(gate.active, 1);
  assert.equal(gate.tryAcquire("u3", "c.example").ok, true);
});

test("G2 the per-person ceiling refuses that person only", () => {
  const gate = new OutboundFetchGate({ global: 10, perUser: 1, perHost: 10 });
  assert.equal(gate.tryAcquire("u1", "a.example").ok, true);
  assert.deepEqual(gate.tryAcquire("u1", "b.example"), { ok: false, refusal: "user" });
  assert.equal(gate.tryAcquire("u2", "b.example").ok, true);
});

test("G3 the per-host ceiling refuses that host only", () => {
  const gate = new OutboundFetchGate({ global: 10, perUser: 10, perHost: 1 });
  assert.equal(gate.tryAcquire("u1", "a.example").ok, true);
  assert.deepEqual(gate.tryAcquire("u2", "a.example"), { ok: false, refusal: "host" });
  assert.equal(gate.tryAcquire("u2", "b.example").ok, true);
});
