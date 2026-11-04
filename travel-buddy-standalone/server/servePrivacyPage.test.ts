/**
 * /privacy — the hosted privacy policy URL the stores ask for (App Store Connect "Privacy Policy URL",
 * Play Console "Privacy policy"). It is served beside the landing page from templates/privacy-policy.html,
 * so the URL lives on the host that also serves the share pages and the association files (rumazi.com).
 *
 * The page carries no script (helmet's CSP is script-src 'self'; the page needs none) and no unfilled
 * template placeholder. It also does NOT describe the Stories deletion schedule: per the draft's reviewer
 * notes (privacy-policy-draft.md), those paragraphs may be published only once the retention job enforces
 * them, and as of this test nothing deletes stories on a schedule.
 *
 * Run: node --import tsx/esm --test server/servePrivacyPage.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
const { createRequestHandler } = require2("./serve.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(__dirname, "templates", "landing-page.html"), "utf8");
const basePath = (process.env.BASE_PATH || "/").replace(/\/+$/, "");
const withBasePath = (route: string) => `${basePath}${route}` || "/";
const headers = { "x-forwarded-host": "rumazi.com" };
let server: http.Server | undefined;
let origin = "";

before(async () => {
  server = http.createServer(createRequestHandler(template, "Portava"));
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
});

describe("/privacy: the hosted privacy policy", () => {
  it("serves the policy as HTML at /privacy, /privacy/ and /privacy-policy", async () => {
    for (const route of ["/privacy", "/privacy/", "/privacy-policy"]) {
      const r = await fetch(origin + withBasePath(route), { headers });
      assert.equal(r.status, 200, route);
      assert.match(r.headers.get("content-type") ?? "", /^text\/html/, route);
      const html = await r.text();
      assert.match(html, /<title>Portava Privacy Policy<\/title>/);
      assert.match(html, /<h1>Portava Privacy Policy<\/h1>/);
      assert.match(html, /Delete your account in Settings/);
      assert.match(html, /We cannot read them\./, "the E2EE statement");
    }
  });

  it("answers HEAD like GET, without a body", async () => {
    const r = await fetch(origin + withBasePath("/privacy"), { method: "HEAD", headers });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(await r.text(), "");
  });

  it("carries no script and no unfilled placeholder", async () => {
    const html = await (await fetch(origin + withBasePath("/privacy"), { headers })).text();
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /[A-Z_]+_PLACEHOLDER/);
  });

  it("does not publish the Stories deletion schedule before a retention job enforces it", async () => {
    const html = await (await fetch(origin + withBasePath("/privacy"), { headers })).text();
    assert.doesNotMatch(html, /365 days|private archive|Who saw a story/);
  });

  it("the landing page links to it", async () => {
    const html = await (await fetch(origin + withBasePath("/"), { headers })).text();
    const expected = `href="${basePath}/privacy"`;
    assert.ok(html.includes(expected), `landing page should contain ${expected}`);
  });

  it("a different method is not served the page", async () => {
    const r = await fetch(origin + withBasePath("/privacy"), { method: "POST", headers });
    assert.notEqual(r.status, 200);
  });
});
