/**
 * The landing page at the app root (rumazi.com) sends people to the NATIVE build, never to Expo Go.
 *
 * Expo Go on the App Store runs SDK 57; Portava is SDK 54 and MapLibre needs a native build, so the old page — "Download
 * Expo Go", an exps:// QR, and a script that auto-opened exps:// on every phone — dead-ended every iPhone. The page now
 * shows TestFlight + the configured invite link (PORTAVA_IOS_INSTALL_URL / PORTAVA_ANDROID_INSTALL_URL, https on an
 * allowed host only), says plainly when no link is open yet, and its QR opens the page itself on a phone.
 *
 * It also keeps working under helmet's default CSP (script-src 'self'): one same-origin script, no inline script, no
 * CDN, and a same-origin PNG QR.
 *
 * Run: node --import tsx/esm --test server/serveLandingPageQr.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
const jsQR = require2("jsqr");
const { PNG } = require2("pngjs");
const { createRequestHandler, installLink } = require2("./serve.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(__dirname, "templates", "landing-page.html"), "utf8");
const basePath = (process.env.BASE_PATH || "/").replace(/\/+$/, "");
const withBasePath = (route: string) => `${basePath}${route}` || "/";
const headers = { "x-forwarded-host": "rumazi.com" };
const ENV = ["PORTAVA_IOS_INSTALL_URL", "PORTAVA_ANDROID_INSTALL_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let server: http.Server | undefined;
let origin = "";

async function landing(): Promise<string> {
  const r = await fetch(origin + withBasePath("/"), { headers });
  assert.equal(r.status, 200);
  return r.text();
}

before(async () => {
  for (const k of ENV) delete process.env[k];
  server = http.createServer(createRequestHandler(template, "Portava")); // the default renderer: serve.js loads qrcode itself
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
});

describe("landing page: the supported install path", () => {
  it("never sends anyone to Expo Go", async () => {
    const html = await landing();
    assert.doesNotMatch(html, /exps:\/\/|host\.exp\.exponent|id982107779|EXPS_URL_PLACEHOLDER/);
    assert.doesNotMatch(html, /Download Expo Go|Open in Expo Go/);
    const script = await (await fetch(origin + withBasePath("/landing-page.js"), { headers })).text();
    assert.doesNotMatch(script, /location\.(href|assign|replace)|exps:/, "the script must not redirect");
  });

  it("with no link configured: TestFlight to install, and a plain 'not open yet' instead of a dead button", async () => {
    const html = await landing();
    assert.match(html, /href="https:\/\/apps\.apple\.com\/app\/testflight\/id899247664"/);
    assert.match(html, /The iPhone invite link isn&#39;t open yet/);
    assert.match(html, /Portava for Android isn&#39;t available to install yet/);
    assert.doesNotMatch(html, /[A-Z_]+_PLACEHOLDER/, "every placeholder is filled");
  });

  it("shows the configured TestFlight / Play links, escaped", async () => {
    process.env.PORTAVA_IOS_INSTALL_URL = "https://testflight.apple.com/join/AbC123xy";
    process.env.PORTAVA_ANDROID_INSTALL_URL = "https://play.google.com/store/apps/details?id=com.passporttravelbuddy.app&hl=en";
    try {
      const html = await landing();
      assert.match(html, /<a class="store-button primary" href="https:\/\/testflight\.apple\.com\/join\/AbC123xy" rel="noopener">Open the Portava invite in TestFlight<\/a>/);
      assert.match(html, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.passporttravelbuddy\.app&amp;hl=en"/);
      assert.doesNotMatch(html, /isn&#39;t open yet|isn&#39;t available/);
    } finally {
      for (const k of ENV) delete process.env[k];
    }
  });

  it("refuses a link that is not https on an allowed host", () => {
    const bad = ["http://testflight.apple.com/join/x", "javascript:alert(1)", "https://testflight.apple.com.evil.example/join/x",
      "https://evil.example/?testflight.apple.com", "https://user:pw@testflight.apple.com/join/x", "not a url", "https://play.google.com/store"];
    try {
      for (const v of bad) {
        process.env.PORTAVA_IOS_INSTALL_URL = v;
        assert.equal(installLink("ios"), null, v);
      }
      process.env.PORTAVA_IOS_INSTALL_URL = "https://expo.dev/accounts/travel-buddy1/projects/travel-buddy/builds/0f";
      assert.equal(installLink("ios")?.label, "Install the Portava iPhone build");
    } finally {
      delete process.env.PORTAVA_IOS_INSTALL_URL;
    }
  });
});

describe("landing page: CSP-compatible assets", () => {
  it("one same-origin script, no inline script, no CDN", async () => {
    const html = await landing();
    assert.match(html, new RegExp(`<script src="${withBasePath("/landing-page.js")}" defer></script>`));
    assert.equal((html.match(/<script\b/gi) || []).length, 1);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /unpkg\.com|cdn\.|qr-code-styling/i);
    const r = await fetch(origin + withBasePath("/landing-page.js"), { headers });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /^application\/javascript/);
  });

  it("serves a same-origin QR PNG that opens this page on a phone", async () => {
    const html = await landing();
    assert.match(html, new RegExp(`src="${withBasePath("/qr-code.png")}"`));
    const r = await fetch(origin + withBasePath("/qr-code.png"), { headers });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /^image\/png/);
    const image = PNG.sync.read(Buffer.from(await r.arrayBuffer()));
    const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    assert.ok(decoded, "the QR image should decode");
    assert.equal(decoded.data, `https://rumazi.com${basePath}/`);
  });
});
