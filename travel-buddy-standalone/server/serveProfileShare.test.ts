/**
 * /u/<username> share page — OG metadata visibility tests
 *
 * Locks in the privacy contract of serveProfileSharePage/fetchProfileCard:
 *   - public profile      → personalized og:title/description + per-user og-image URL
 *   - private profile     → generic tags + generic (username-less) og-image URL
 *   - blocked profile     → generic
 *   - unavailable account → generic
 *   - unknown user (404)  → generic
 *   - API failure         → generic
 *
 * Run: node --import tsx/esm --test server/serveProfileShare.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);

process.env.API_ORIGIN = "https://api.test";
const { serveProfileSharePage, fetchProfileCard } = require2("./serve.js");

const APP_NAME = "Travel Buddy";
const GENERIC_TITLE = `${APP_NAME} Passport`;
const GENERIC_DESC = "A traveler&#39;s passport of trips, stamps &amp; postcards.";
const GENERIC_IMAGE = "https://api.test/api/users/_/og-image.png";

// ── Helpers ───────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

/** Stub global fetch to return the given profile-card JSON (or an error). */
function stubFetch(handler: () => Promise<{ ok: boolean; json?: any }>) {
  globalThis.fetch = (async () => {
    const r = await handler();
    return {
      ok: r.ok,
      json: async () => r.json,
    } as any;
  }) as any;
}

function fakeReq() {
  return {
    method: "GET",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "share.test" },
  } as any;
}

function fakeRes() {
  const chunks: string[] = [];
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      Object.assign(res.headers, headers ?? {});
    },
    end(data?: string) {
      if (data) chunks.push(String(data));
      res.body = chunks.join("");
    },
    body: "",
  };
  return res;
}

async function renderPage(username: string): Promise<string> {
  const res = fakeRes();
  await serveProfileSharePage(fakeReq(), res, username, APP_NAME);
  assert.equal(res.statusCode, 200);
  return res.body as string;
}

function metaContent(html: string, property: string): string | null {
  const m = new RegExp(
    `<meta (?:property|name)="${property}" content="([^"]*)"`,
  ).exec(html);
  return m ? m[1] : null;
}

function assertGeneric(html: string, username: string) {
  assert.equal(metaContent(html, "og:title"), GENERIC_TITLE);
  assert.equal(metaContent(html, "og:description"), GENERIC_DESC);
  assert.equal(metaContent(html, "og:image"), GENERIC_IMAGE);
  assert.equal(metaContent(html, "twitter:image"), GENERIC_IMAGE);
  // Absolutely no personal data anywhere in the page.
  assert.ok(!html.includes("Secret"), "must not leak display name");
  assert.ok(
    !html.includes(`/users/${username}/og-image.png`),
    "must not point at the per-user og-image",
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("serveProfileSharePage OG metadata visibility", () => {
  it("public profile → personalized title, description, and og-image URL", async () => {
    stubFetch(async () => ({
      ok: true,
      json: {
        username: "wanda",
        displayName: "Wanda Wanderer",
        bio: "Chasing sunsets",
        tripCount: 3,
        stampCount: 1,
        visibility: "public",
      },
    }));
    const html = await renderPage("wanda");
    assert.equal(metaContent(html, "og:title"), `Wanda Wanderer · ${APP_NAME} Passport`);
    assert.equal(
      metaContent(html, "og:description"),
      "3 trips · 1 stamp — Chasing sunsets",
    );
    assert.equal(
      metaContent(html, "og:image"),
      "https://api.test/api/users/wanda/og-image.png",
    );
    assert.equal(metaContent(html, "twitter:title"), `Wanda Wanderer · ${APP_NAME} Passport`);
  });

  it("public profile without bio → stats-only description", async () => {
    stubFetch(async () => ({
      ok: true,
      json: { username: "sam", displayName: "Sam", tripCount: 1, stampCount: 2, visibility: "public" },
    }));
    const html = await renderPage("sam");
    assert.equal(metaContent(html, "og:description"), `1 trip · 2 stamps on ${APP_NAME}.`);
  });

  it("private profile (private flag) → generic tags and generic og-image", async () => {
    stubFetch(async () => ({
      ok: true,
      json: {
        private: true,
        username: "hidden",
        displayName: "Secret Name",
        tripCount: 0,
        stampCount: 0,
        visibility: "private",
      },
    }));
    assertGeneric(await renderPage("hidden"), "hidden");
  });

  it('private profile (visibility:"private" only) → generic', async () => {
    stubFetch(async () => ({
      ok: true,
      json: { username: "hidden2", displayName: "Secret Two", visibility: "private" },
    }));
    assertGeneric(await renderPage("hidden2"), "hidden2");
  });

  it("blocked profile → generic", async () => {
    stubFetch(async () => ({ ok: true, json: { blocked: true } }));
    assertGeneric(await renderPage("blocky"), "blocky");
  });

  it("unavailable account → generic", async () => {
    stubFetch(async () => ({ ok: true, json: { unavailable: true } }));
    assertGeneric(await renderPage("gone"), "gone");
  });

  it("unknown user (API 404) → generic", async () => {
    stubFetch(async () => ({ ok: false }));
    assertGeneric(await renderPage("nobody"), "nobody");
  });

  it("API failure (network error) → generic", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as any;
    assertGeneric(await renderPage("whoever"), "whoever");
  });
});

describe("fetchProfileCard", () => {
  it("returns parsed JSON on success", async () => {
    stubFetch(async () => ({ ok: true, json: { username: "ok" } }));
    assert.deepEqual(await fetchProfileCard("https://x.test", "ok"), { username: "ok" });
  });

  it("returns null on non-OK response", async () => {
    stubFetch(async () => ({ ok: false }));
    assert.equal(await fetchProfileCard("https://x.test", "missing"), null);
  });

  it("returns null (never throws) on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as any;
    assert.equal(await fetchProfileCard("https://x.test", "err"), null);
  });
});
