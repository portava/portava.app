/**
 * Telegraph §17.4 / census-telegraph T239, server half — every answer says how long the SERVER spent
 * on it, so the app's bandwidth signal can tell a slow network from a slow server.
 *
 * WHAT IS EXERCISED: the real `telegraphObservability()` middleware (mounted in app.ts for every path,
 * before the router) over node's own IncomingMessage / ServerResponse — no socket is opened, so the
 * sandbox's listen(2) ban does not apply — and `res.end()` drives node's own implicit writeHead, which
 * is where the header is stamped.
 *
 * Run: node --import tsx/esm --test src/test/telegraphServerTiming.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Request, Response } from "express";

import { telegraphObservability, SERVER_TIMING_METRIC } from "../middlewares/telegraphObservability.js";

function reqRes(method: string, path: string): { req: Request; res: Response } {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path;
  (req as unknown as { path: string }).path = path; // express's own getter, as an own property
  const res = new ServerResponse(req);
  return { req: req as unknown as Request, res: res as unknown as Response };
}

/** Run the middleware, let the "handler" take `handlerMs`, then answer. */
async function answer(method: string, path: string, handlerMs: number, before?: (res: Response) => void) {
  const { req, res } = reqRes(method, path);
  await new Promise<void>((resolve) => {
    telegraphObservability()(req, res, () => {
      setTimeout(() => {
        before?.(res);
        res.statusCode = 200;
        res.end("ok");
        resolve();
      }, handlerMs);
    });
  });
  return res;
}

function durOf(header: unknown): number {
  const m = /^app;dur=(\d+)$/.exec(String(header));
  assert.ok(m, `Server-Timing is "app;dur=<whole ms>": ${String(header)}`);
  return Number(m![1]);
}

describe("T239 — Server-Timing on every answer", () => {
  it("an ordinary API answer carries app;dur covering the handler's time", async () => {
    const res = await answer("GET", "/api/me/threads", 40);
    assert.equal(SERVER_TIMING_METRIC, "app");
    const dur = durOf(res.getHeader("Server-Timing"));
    assert.ok(dur >= 30, `dur ${dur} covers a 40 ms handler`);
    assert.ok(dur < 5000, `dur ${dur} is the server's time, not a clock`);
  });

  it("a path the Telegraph SLOs do not classify is stamped too (the client times every GET it makes)", async () => {
    const res = await answer("GET", "/api/profiles/me", 5);
    durOf(res.getHeader("Server-Timing"));
  });

  it("a value another layer already set is never overwritten", async () => {
    const res = await answer("GET", "/api/me/threads", 5, (r) => r.setHeader("Server-Timing", "edge;dur=7"));
    assert.equal(res.getHeader("Server-Timing"), "edge;dur=7");
  });

  it("the header carries a duration and nothing else (no path, no id, no content)", async () => {
    const res = await answer("POST", "/api/threads/00000000-0000-4000-8000-00000000000d/messages", 1);
    assert.match(String(res.getHeader("Server-Timing")), /^app;dur=\d+$/);
  });

  it("a browser build may read it: the CORS config exposes Server-Timing (source level; app.ts boots schedulers on import)", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    assert.match(app, /credentials: true, exposedHeaders: \["Server-Timing"\],/);
  });
});
