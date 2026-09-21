/**
 * measureInputAssistanceLatency — the §49/G354 performance harness.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS THE INSTRUMENT. IT IS NOT THE MEASUREMENT.
 * ══════════════════════════════════════════════════════════════════════════════
 * `census-input-intelligence.md` grades G354 — "Performance — P50/P95 latency /
 * cold start / render cost / large index behaviour" — CANNOT-VERIFY, with the
 * reason: "No latency, cold-start, render-cost or large-index test or harness
 * exists. The required certification is a measurement against a running server
 * and device; it cannot be satisfied or refuted from this tree."
 *
 * Half of that is now false: this harness exists. The other half is still true
 * and this file must not be read as changing it. Running this against a
 * deployment produces THE NUMBER; writing it did not. The ledger in
 * `docs/architecture/input-intelligence-performance-protocol.md` reads NOT RUN
 * for every row, following `docs/map/device-measurement-protocol.md`, whose
 * rows read NOT RUN because no physical handset existed in any session that
 * wrote it. Nothing in this repository may enter a simulated, unit or synthetic
 * result in those rows as a substitute.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THREE OF G354'S FOUR DIMENSIONS ARE SERVER-SIDE. THE FOURTH IS NOT.
 * ══════════════════════════════════════════════════════════════════════════════
 *   P50/P95 LATENCY  — measured here, twice over: the round trip this process
 *                      saw, and the `serverMs` the serve measured of itself.
 *                      Both, because the difference between them is the network
 *                      and neither side can see it alone.
 *   COLD START       — the FIRST request against a freshly started server,
 *                      reported on its own line and NEVER folded into the warm
 *                      sample. A cold start averaged into a P50 disappears.
 *   LARGE INDEX      — the same corpus run at its most and least selective. An
 *                      index that degrades shows up as a latency gap at a stated
 *                      result count, not as a single slow number.
 *   RENDER COST      — NOT MEASURABLE HERE, and refused rather than approximated.
 *                      It is a device frame-timing question (`SuggestionOverlay`
 *                      drawing N rows on real hardware) and belongs in the
 *                      device protocol with the rest of §46's device rows.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * IT REFUSES TO REPORT A PERCENTILE IT CANNOT SUPPORT
 * ══════════════════════════════════════════════════════════════════════════════
 * A P95 over nine samples is the ninth value with a confident name on it. Below
 * MIN_WARM_SAMPLES this prints NOT RUN and exits non-zero, which is the same
 * rule §2 of the device protocol applies to its frame captures.
 *
 * AND IT DOES NOT WIDEN THE RATE LIMIT TO GET ITS SAMPLE. The suggest route
 * allows 90 requests per user per minute (`routes/inputAssistance.ts:153`). This
 * paces itself under that ceiling and reports the pacing, because a harness that
 * needs a limit raised is measuring a different system than the one that serves
 * users.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * USAGE — the operator with deployment access runs this; it is READ-ONLY
 * ══════════════════════════════════════════════════════════════════════════════
 *   INPUT_ASSIST_BASE_URL=https://…/api \
 *   INPUT_ASSIST_TOKEN=<a real user bearer token> \
 *     node --import tsx/esm src/scripts/measureInputAssistanceLatency.ts
 *
 *   …--iterations 120 --context global_search --json
 *
 * It issues only `POST /input-assistance/suggest`, which reads and never writes.
 * The token identifies the user the rate limit is keyed to; use a test account.
 */

interface Sample {
  query: string;
  clientMs: number;
  serverMs: number | null;
  count: number;
  status: number;
}

/**
 * Below this, no percentile is printed. Ten is the device protocol's floor for
 * a run; latency is cheaper to sample, so this is higher.
 */
const MIN_WARM_SAMPLES = 60;

/** The route's own ceiling, per user, per minute. Never exceeded. */
const ROUTE_RATE_LIMIT_PER_MIN = 90;
/** Stay clearly inside it: 70 rpm leaves headroom for whatever else that user does. */
const TARGET_RPM = 70;

/**
 * SELECTIVE — queries that should match a handful of canonical rows.
 * UNSELECTIVE — short, common prefixes that should match a great many. The pair
 * is the large-index probe: if the index degrades with candidate-set size, the
 * gap between these two opens up, and both are reported with their result counts
 * so "slower" can be read against "returned more".
 */
const SELECTIVE = ['reykjavik', 'ljubljana', 'chiang mai', 'ushuaia', 'trondheim'];
const UNSELECTIVE = ['sa', 'ba', 'la', 'san', 'ne'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function percentile(sample: readonly number[], p: number): number | null {
  if (sample.length === 0) return null;
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function one(
  base: string,
  token: string,
  context: string,
  fieldId: string,
  query: string,
): Promise<Sample> {
  const startedAt = Date.now();
  const res = await fetch(`${base}/input-assistance/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ context, fieldId, text: query, limit: 10 }),
  });
  const clientMs = Date.now() - startedAt;
  let serverMs: number | null = null;
  let count = 0;
  try {
    const body = (await res.json()) as { serverMs?: unknown; suggestions?: unknown };
    serverMs = typeof body.serverMs === 'number' ? body.serverMs : null;
    count = Array.isArray(body.suggestions) ? body.suggestions.length : 0;
  } catch {
    /* a non-JSON body is still a latency observation */
  }
  return { query, clientMs, serverMs, count, status: res.status };
}

function report(label: string, samples: readonly Sample[]): string[] {
  const client = samples.map((s) => s.clientMs);
  const server = samples.flatMap((s) => (s.serverMs === null ? [] : [s.serverMs]));
  const counts = samples.map((s) => s.count);
  const avgCount = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  return [
    `  ${label}`,
    `    n                  ${samples.length}`,
    `    round trip  P50    ${percentile(client, 50)} ms`,
    `    round trip  P95    ${percentile(client, 95)} ms`,
    server.length
      ? `    serve self  P50    ${percentile(server, 50)} ms`
      : '    serve self  P50    ABSENT — this deployment sends no `serverMs`',
    server.length ? `    serve self  P95    ${percentile(server, 95)} ms` : '',
    `    mean suggestions   ${avgCount.toFixed(1)}`,
  ].filter(Boolean);
}

async function main(): Promise<void> {
  const base = (process.env.INPUT_ASSIST_BASE_URL ?? arg('base') ?? '').replace(/\/$/, '');
  const token = process.env.INPUT_ASSIST_TOKEN ?? arg('token') ?? '';
  const context = arg('context') ?? 'global_search';
  const fieldId = arg('field') ?? 'discovery.search';
  const iterations = Number(arg('iterations') ?? 120);
  const json = process.argv.includes('--json');

  if (!base || !token) {
    console.error(
      'measureInputAssistanceLatency: NOT RUN — missing prerequisites.\n' +
        '  INPUT_ASSIST_BASE_URL  the deployment to measure (e.g. https://host/api)\n' +
        '  INPUT_ASSIST_TOKEN     a real user bearer token for that deployment\n' +
        'Without both, no measurement is possible. This is a failed prerequisite, ' +
        'not a performance result.',
    );
    process.exit(2);
  }

  const gapMs = Math.ceil(60_000 / TARGET_RPM);
  const corpus = [...SELECTIVE, ...UNSELECTIVE];

  // ── COLD START ──────────────────────────────────────────────────────────────
  // Only meaningful against a server that has just started. The harness cannot
  // verify that it did — an operator has to know — so the output says so rather
  // than implying a cold number was obtained.
  const cold = await one(base, token, context, fieldId, SELECTIVE[0]);

  // ── WARM ────────────────────────────────────────────────────────────────────
  const warm: Sample[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const q = corpus[i % corpus.length];
    warm.push(await one(base, token, context, fieldId, q));
    await sleep(gapMs);
  }

  const failed = warm.filter((s) => s.status !== 200);
  const ok = warm.filter((s) => s.status === 200);
  const selective = ok.filter((s) => SELECTIVE.includes(s.query));
  const unselective = ok.filter((s) => UNSELECTIVE.includes(s.query));

  if (json) {
    console.log(
      JSON.stringify(
        {
          base,
          context,
          fieldId,
          pacing: { targetRpm: TARGET_RPM, routeLimitPerMin: ROUTE_RATE_LIMIT_PER_MIN, gapMs },
          coldStart: cold,
          warm: ok,
          failed,
          sufficient: ok.length >= MIN_WARM_SAMPLES,
          renderCost: 'NOT MEASURABLE HERE — device frame timing; see the device protocol',
        },
        null,
        2,
      ),
    );
    if (ok.length < MIN_WARM_SAMPLES) process.exit(3);
    return;
  }

  console.log(`\n§49/G354 input-assistance performance — ${base}`);
  console.log(`  context ${context} · field ${fieldId}`);
  console.log(
    `  pacing: ${TARGET_RPM} req/min (route allows ${ROUTE_RATE_LIMIT_PER_MIN}/min/user) — not raised for this run`,
  );
  console.log(`  non-200 responses: ${failed.length}`);
  console.log('');
  console.log(
    `  COLD START         ${cold.clientMs} ms round trip · ${cold.serverMs ?? 'n/a'} ms serve` +
      ' (valid ONLY if the server had just started)',
  );
  console.log('');

  if (ok.length < MIN_WARM_SAMPLES) {
    console.log(
      `  NOT RUN — ${ok.length} successful samples, ${MIN_WARM_SAMPLES} required. ` +
        'A P95 over a short sample is one observation with a confident name on it; ' +
        'no percentile is printed.',
    );
    process.exit(3);
  }

  for (const line of report('ALL WARM', ok)) console.log(line);
  console.log('');
  console.log('  LARGE INDEX PROBE — the same corpus at both ends of selectivity');
  for (const line of report('selective queries', selective)) console.log(line);
  for (const line of report('unselective prefixes', unselective)) console.log(line);
  console.log('');
  console.log(
    '  RENDER COST        NOT MEASURABLE HERE — overlay frame timing on real hardware.\n' +
      '                     See docs/architecture/input-intelligence-performance-protocol.md §4.',
  );
  console.log('');
}

void main();
