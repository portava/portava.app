#!/usr/bin/env node
/**
 * serve-wall-frame-fixture — serves the pinned 60-item For You feed that the
 * W149 frame-time capture scrolls.
 *
 * Usage, from travel-buddy-standalone:
 *
 *   WALL_FIXTURE_MEDIA_BASE=http://<your-host>:8081/media \
 *     node --import tsx scripts/serve-wall-frame-fixture.ts
 *
 * Then build the app against it (see docs/architecture/wall-certification-packet.md §2):
 *
 *   EXPO_PUBLIC_API_BASE_URL=http://<this-host>:8788 npx expo run:android --variant release
 *
 * WHY THIS LIVES IN scripts/ AND NOT src/
 * =======================================
 * Same reason scripts/dev-same-origin-proxy.mjs does, and the reason
 * scripts/check-dev-proxy-not-shipped.mjs exists to enforce it: a server that
 * answers API routes must not be reachable from the Metro module graph. Nothing
 * under app/ or src/ imports this file. It imports the fixture (which is pure
 * data and is itself unreferenced by app code), never the other way round.
 *
 * WHAT IT IS NOT
 * ==============
 * Not a mock of the Wall API's semantics and not a substitute for it. It answers
 * exactly the seven routes the client calls, ignores the Authorization header,
 * and serves a FIXED feed. It is a frame-time test harness: its only job is to
 * put identical bytes in front of the device on every run so two people's traces
 * are comparable. Nothing about server correctness, ranking, eligibility or
 * latency can be concluded from it — those are W146's and the census's, not this
 * file's.
 */

import { createServer } from 'node:http';
import { buildFrameCaptureFeed, pageOf } from '../src/features/wall/certification/wallFrameCaptureFixture.ts';

const PORT = Number(process.env.PORT ?? 8788);
const MEDIA_BASE = process.env.WALL_FIXTURE_MEDIA_BASE ?? '';

// Throws with an explanatory message when MEDIA_BASE is unset — deliberately at
// startup rather than per request, so the operator finds out before the device
// is wired up rather than after a meaningless trace has been captured.
const FEED = buildFrameCaptureFeed({ mediaBase: MEDIA_BASE });

let requestCount = 0;

const server = createServer((req, res) => {
  requestCount += 1;
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/^\/api/, '');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const send = (body: unknown, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };

  // The Wall tab is hidden until the client's FeatureFlagsContext sees
  // `wall_enabled` (app/(tabs)/_layout.tsx), and that context reads
  // GET /api/feature-flags off the SAME base URL. Answering it here is what
  // lets the capture be driven the way a user drives it — tap the Wall tab —
  // instead of side-loading the route by deep link. Only the Wall's own flags
  // are returned; every other surface stays dark, which is correct for a build
  // whose entire purpose is to scroll one screen.
  if (path === '/feature-flags' && req.method === 'GET') {
    return send({
      flags: {
        wall_enabled: true,
        wall_live_for_you_enabled: true,
        wall_input_intelligence_enabled: true,
        wall_discovery_insertions_enabled: true,
        wall_compass_handoff_enabled: true,
        wall_context_threads_enabled: true,
        wall_rab_integration_enabled: true,
      },
    });
  }

  if (path === '/wall' && req.method === 'GET') {
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 40);
    const page = pageOf(FEED, cursor, limit);
    console.log(
      `[fixture] GET /wall cursor=${cursor ?? '-'} limit=${limit} -> ${page.items.length} items` +
        `${page.nextCursor ? ` next=${page.nextCursor}` : ' (last page)'}`,
    );
    return send(page);
  }
  if (path === '/wall/live' && req.method === 'GET') return send({ liveForYou: [], generatedAt: FEED.generatedAt });
  if (path === '/wall/quick-media' && req.method === 'GET') return send({ items: [], generatedAt: FEED.generatedAt });
  // Fire-and-forget telemetry and the session-intent verbs. Accepted and
  // discarded: the capture must not be perturbed by the harness answering
  // slowly, and nothing downstream reads them.
  if (path === '/wall/impression' || path === '/wall/action' || path === '/wall/revalidate') return send({ ok: true });
  if (path === '/wall/session-intent') return send({ ok: true });

  console.log(`[fixture] unhandled ${req.method} ${url.pathname}`);
  return send({ error: 'not_found' }, 404);
});

server.listen(PORT, () => {
  console.log(
    `wall frame-capture fixture on :${PORT}\n` +
      `  items:      ${FEED.items.length}\n` +
      `  media base: ${MEDIA_BASE}\n` +
      `  page size:  20 (matches routes/wall.ts DEFAULT_LIMIT), so 60 items = 3 pages\n` +
      `Point the app at it with EXPO_PUBLIC_API_BASE_URL=http://<this-host>:${PORT}\n`,
  );
});

process.on('SIGINT', () => {
  console.log(`\n[fixture] ${requestCount} request(s) served. Stopping.`);
  server.close(() => process.exit(0));
});
