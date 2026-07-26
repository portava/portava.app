/**
 * fallbackStaticAssets.test.ts
 *
 * Confirms that the express.static middleware in app.ts serves the bundled
 * category fallback WebPs at /fallbacks/<slug>.webp with a 200 status and the
 * expected Cache-Control header.  A 404 here means the static root path in
 * app.ts resolves to the wrong directory.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function get(
  port: number,
  path: string,
): Promise<{ status: number; headers: Record<string, string> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /fallbacks — static category WebP assets", () => {
  let server: Server;
  let port: number;

  // Single server instance shared across the suite for speed.
  const setup = startServer().then((s) => { server = s.server; port = s.port; });

  after(async () => {
    await setup.catch(() => {});
    if (server) await stopServer(server);
  });

  it("serves generic-place.webp with 200", async () => {
    await setup;
    const { status } = await get(port, "/fallbacks/generic-place.webp");
    assert.equal(status, 200, "expected HTTP 200 for generic-place.webp");
  });

  it("serves generic-event.webp with 200", async () => {
    await setup;
    const { status } = await get(port, "/fallbacks/generic-event.webp");
    assert.equal(status, 200, "expected HTTP 200 for generic-event.webp");
  });

  it("serves restaurant.webp with 200", async () => {
    await setup;
    const { status } = await get(port, "/fallbacks/restaurant.webp");
    assert.equal(status, 200, "expected HTTP 200 for restaurant.webp");
  });

  it("returns 404 for a non-existent slug", async () => {
    await setup;
    const { status } = await get(port, "/fallbacks/nonexistent-category.webp");
    assert.equal(status, 404, "unknown slug must return 404");
  });

  it("includes Cache-Control header with max-age", async () => {
    await setup;
    const { headers } = await get(port, "/fallbacks/beach.webp");
    const cc = headers["cache-control"] ?? "";
    assert.ok(
      cc.includes("max-age"),
      `expected Cache-Control with max-age, got: "${cc}"`,
    );
  });
});
