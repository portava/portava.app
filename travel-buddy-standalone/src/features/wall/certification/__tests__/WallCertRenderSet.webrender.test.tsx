/**
 * WallCertRenderSet — emits and guards the screenshot set that census-wall rows
 * W159 and W167 have been waiting on, and proves it is reproducible.
 *
 * Runs under jest.web.config.js (jest-expo/web → react-native-web + react-dom +
 * jsdom), wired into `pnpm run test:component`.
 *
 * WHAT THIS IS FOR
 * ================
 * W159 and W167 both terminate in "a named designer's sign-off, or refusal,
 * against a screenshot set of the five object renderers at the supported width
 * range". Neither row can be closed by a test and this file does not try. What
 * it does is remove the only part of that sentence a machine can do: it BUILDS
 * the set, from the real renderers, deterministically, into one self-contained
 * HTML page a reviewer opens in a browser — no toolchain, no device, no build.
 * The review question is then the only thing left.
 *
 * WHY HTML AND NOT PNG. Producing pixels needs a browser or a device, and this
 * container has neither (no chromium, no puppeteer/playwright, no Android SDK,
 * no /dev/kvm). An emitted HTML page is the furthest an automated step can get
 * here, and it is genuinely further than a fixture dump: the page carries the
 * real react-native-web stylesheet, so a browser lays it out the way the code
 * says, and the reviewer's own screenshot tool does the rasterising.
 *
 * WHAT THIS IS NOT. react-native-web is NOT the Android renderer. Shadow
 * rendering, font metrics and text measurement all differ from RN on device.
 * The page is a HIGH-FIDELITY PROXY for judging density, rhythm and whitespace
 * — which is what W159/W167 ask — and is NOT evidence about pixel-exact device
 * appearance. That limitation is stated in the packet, on the emitted page
 * itself, and on the sign-off form, so a reviewer cannot sign it unknowingly.
 *
 * THE THREE ASSERTIONS, AND WHY EACH IS NOT DECORATION
 * ===================================================
 * 1. COVERAGE — all five renderers, both densities, actually rendered. A review
 *    set that silently lost a renderer would produce a sign-off that covers
 *    four. Mutation proof: dropping any entry from CERT_CASES turns this red.
 *
 * 2. THE DENSITY CEILING IS THE ONE W167 NAMES — the ceiling cards really do
 *    carry one action row, exactly three chips and exactly one context thread.
 *    This is not a duplicate of WallDesignSystem's `slice(0, 3)` pin: that one
 *    asserts the chip cap in isolation, this one asserts that the COMPOSITE the
 *    designer is asked to rule on is the composite that was put in front of
 *    them. Mutation proof: raising the chip slice, or rendering a second
 *    thread, turns this red.
 *
 * 3. THE SIGN-OFF ARTIFACT IS STILL THE CURRENT CODE — the committed page's
 *    embedded digest matches what the renderers produce today.
 *
 *    THIS IS THE POINT OF THE WHOLE FILE. A design sign-off names an artifact
 *    and a date. If the renderers move afterwards, the signature silently comes
 *    to cover something that is no longer shipping — which is the exact way a
 *    "certified" row rots into a lie. Here it cannot happen quietly: change a
 *    renderer and this test goes red and says so. The fix is one command
 *    (re-emit), and the consequence is the honest one — the sign-off is void
 *    and the review is re-run against what actually ships.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// The Wall renderers pull wallAnalytics → wallApi, whose real module loads the
// supabase/apiToken chain at import and crashes the suite. Mirrors the stub in
// WallDesignSystem.component.test.tsx; nothing here is invoked by a pure render
// — the mock exists only to keep the import graph loadable under jsdom.
// NOTE: exhaustive-by-design mock, for the reason directly above.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
  revalidateCachedObjects: jest.fn(async () => ({ ok: false, error: 'Network error' })),
}));

// NOTE: intentional stub — expo-router has no navigation context under jsdom.
// The render set never navigates; only the module-level import must resolve.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));

// NOTE: intentional stub — real safe-area insets are not part of what is being
// reviewed, and a non-zero inset would make the emitted page device-specific.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { WallObjectRenderer } from '../../components/WallObjectRenderer.tsx';
import {
  CEILING_CHIP_LABELS,
  CEILING_DROPPED_LABEL,
  CEILING_THREAD_KIND,
  CERT_CASES,
  CERT_CLOCK,
  CERT_REQUIRED_RENDERERS,
  CERT_WIDTHS,
  CERT_WIDTH_NOTES,
} from '../wallCertFixtures.ts';

/** The committed sign-off artifact. Re-emit with WALL_CERT_EMIT=1. */
const ARTIFACT = resolve(process.cwd(), '..', 'docs', 'architecture', 'wall-cert-render-set.html');
const EMIT = process.env.WALL_CERT_EMIT === '1';

const DIGEST_MARKER = 'RENDER-DIGEST:';

interface RenderedCase {
  caseId: string;
  width: number;
  html: string;
}

function collectCss(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      rules = null;
    }
    if (rules) {
      for (const rule of Array.from(rules)) out.push(rule.cssText);
      continue;
    }
    const node = sheet.ownerNode as HTMLStyleElement | null;
    if (node?.textContent) out.push(node.textContent);
  }
  return out.join('\n');
}

/** Render every case at every width into jsdom and return the markup. */
function renderAll(): RenderedCase[] {
  const rendered: RenderedCase[] = [];
  for (const width of CERT_WIDTHS) {
    for (const c of CERT_CASES) {
      const host = document.createElement('div');
      host.setAttribute('data-cert-case', c.id);
      host.setAttribute('data-cert-width', String(width));
      document.body.appendChild(host);
      let root: Root | null = null;
      act(() => {
        root = createRoot(host);
        root.render(<WallObjectRenderer projection={c.projection} />);
      });
      rendered.push({ caseId: c.id, width, html: host.innerHTML });
      act(() => {
        root?.unmount();
      });
      host.remove();
    }
  }
  return rendered;
}

function digestOf(rendered: RenderedCase[]): string {
  const h = createHash('sha256');
  for (const r of rendered) h.update(`${r.caseId}@${r.width}\n${r.html}\n`);
  return h.digest('hex').slice(0, 16);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPage(rendered: RenderedCase[], css: string, digest: string): string {
  const byWidth = CERT_WIDTHS.map((width) => {
    const cards = CERT_CASES.map((c) => {
      const r = rendered.find((x) => x.caseId === c.id && x.width === width);
      return `
      <figure class="cert-card" id="cert-${c.id}-${width}">
        <div class="cert-frame" style="width:${width}px">${r?.html ?? ''}</div>
        <figcaption><b>${esc(c.caption)}</b><br><code>${esc(c.id)}</code> at ${width}&thinsp;dp</figcaption>
      </figure>`;
    }).join('');
    return `
    <section class="cert-width">
      <h2>${width} dp</h2>
      <p class="cert-why">${esc(CERT_WIDTH_NOTES[width] ?? '')}</p>
      <div class="cert-row">${cards}</div>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portava Wall — certification render set</title>
<!-- ${DIGEST_MARKER}${digest} -->
<!-- Roboto is the Android platform font. The app sets NO fontFamily anywhere
     (@expo-google-fonts/inter is a dependency but is never loaded — there is no
     useFonts call in the tree), so on the Android floor device every Wall string
     renders in Roboto. Requesting it here is what makes line-breaking in this
     page resemble line-breaking on the device. If the network is unavailable the
     stack falls back to the reviewer's system sans and WRAPPING WILL DIFFER;
     that is called out on the page below. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;800&display=swap">
<!-- GENERATED FILE. Do not hand-edit. Re-emit with:
     cd travel-buddy-standalone && WALL_CERT_EMIT=1 npx jest -c jest.web.config.js WallCertRenderSet -->
<style>
  body { margin:0; background:#f4f2ee; color:#1b1a18;
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .cert-doc { padding:24px; }
  .cert-doc > header { max-width:60em; margin-bottom:32px; }
  .cert-warn { border-left:4px solid #b4531f; background:#fff6f0; padding:12px 16px; margin:16px 0; }
  .cert-width { margin:48px 0; }
  .cert-width h2 { margin:0 0 4px; font-size:20px; }
  .cert-why { margin:0 0 16px; color:#5f5b55; max-width:60em; }
  .cert-row { display:flex; gap:24px; overflow-x:auto; padding-bottom:12px; align-items:flex-start; }
  .cert-card { margin:0; flex:0 0 auto; }
  .cert-frame { background:#fffdf9;
    font-family:Roboto,"Helvetica Neue",Arial,sans-serif; }
  /* ICON SUBSTITUTION — stated, not hidden. lucide-react-native is replaced
     repo-wide under jest by a Proxy stand-in (src/__mocks__/lucide-react-native.tsx)
     that renders an empty View, and react-native-web drops its size prop, so
     every icon would otherwise occupy ZERO width and pull the text beside it
     14-26 px to the left. A neutral square at the Wall's median icon size is a
     closer proxy for the real layout than nothing at all. Real Wall icon sizes,
     counted from the size={icon.N} call sites across src/features/wall:
     14 (x10), 16 (x8),
     20 (x4), 22 (x2), 26 (x2). */
  .cert-frame [data-testid^="icon-"] {
    width:16px; height:16px; flex:0 0 16px; border-radius:3px;
    background:currentColor; opacity:.45;
  }
  figcaption { margin-top:8px; max-width:100%; color:#5f5b55; font-size:12px; }
  figcaption b { color:#1b1a18; }
  @media (prefers-color-scheme: dark) {
    body { background:#141312; color:#f2efe9; }
    .cert-why, figcaption { color:#a39d94; }
    figcaption b { color:#f2efe9; }
    .cert-warn { background:#2a1a10; }
  }
${css}
</style></head>
<body><div class="cert-doc">
<header>
<h1>Portava Wall — certification render set</h1>
<p>The five Wall object renderers, each at a typical density and at the densest
card the code can currently emit, across the proposed supported width range.
Built from the real renderers by
<code>src/features/wall/certification/__tests__/WallCertRenderSet.webrender.test.tsx</code>.</p>
<p>Render digest <code>${digest}</code>. This page is the artifact named on the
W159 / W167 sign-off form in
<code>docs/architecture/wall-certification-packet.md</code>. Sign that form, not this page.</p>
<div class="cert-warn"><b>Read this before reviewing.</b> This page is rendered by
<b>react-native-web</b>, not by React Native on Android or iOS. Layout, spacing and
type scale come from the real component code, but shadow rendering, font metrics and
text measurement differ from a device. It is a fidelity-limited proxy, sound for judging
<b>density, rhythm and whitespace</b> — the two questions being asked — and it is
<b>not</b> evidence about pixel-exact device appearance. Media wells show the real
component's &ldquo;No preview&rdquo; placeholder at the real aspect ratio; no image
bytes are fetched, so every card is lighter here than it will be with a photograph in it.
<br><br><b>Two further substitutions, both visible above:</b> icons are drawn as neutral
16&thinsp;px squares (the harness cannot render lucide glyphs; real Wall icons are
14&ndash;26&thinsp;px), and the page requests <b>Roboto</b>, the Android platform font the
app actually inherits. If Roboto did not load, line wrapping here will not match the
device &mdash; check that this sentence is set in Roboto before judging any width.</div>
</header>
${byWidth}
</div></body></html>
`;
}

describe('Wall certification render set (W159 / W167 review artifact)', () => {
  let rendered: RenderedCase[];
  let css: string;

  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(CERT_CLOCK);
    rendered = renderAll();
    css = collectCss();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('covers all five object renderers at both densities and every width', () => {
    for (const type of CERT_REQUIRED_RENDERERS) {
      for (const density of ['typical', 'ceiling'] as const) {
        const id = `${type}-${density}`;
        for (const width of CERT_WIDTHS) {
          const r = rendered.find((x) => x.caseId === id && x.width === width);
          expect(`${id}@${width}: present`).toBe(r ? `${id}@${width}: present` : 'MISSING');
          // RN `testID` becomes `data-testid` under react-native-web. Its
          // presence is what proves the card actually rendered rather than
          // falling through WallObjectRenderer's unknown-type `return null`.
          expect(r!.html).toContain(`data-testid="wall-item-${type}"`);
        }
      }
    }
  });

  it('the ceiling cards carry the exact composition W167 asks a human to rule on', () => {
    // "One action row + AT MOST THREE chips + AT MOST ONE context thread" —
    // the reviewer must be looking at that, not at something short of it.
    // react-native-web maps accessibilityLabel -> aria-label and testID ->
    // data-testid, so both are countable in the emitted markup.
    for (const type of CERT_REQUIRED_RENDERERS) {
      const r = rendered.find((x) => x.caseId === `${type}-ceiling` && x.width === 390);
      const html = r!.html;
      for (const label of CEILING_CHIP_LABELS) {
        const hits = (html.match(new RegExp(`aria-label="${label}"`, 'g')) ?? []).length;
        expect({ type, label, hits }).toEqual({ type, label, hits: 1 });
      }
      // The fourth eligible action exists in the fixture and must be dropped by
      // the three-chip cap. Without this the fixture would pass with no cap.
      expect({ type, dropped: html.includes(CEILING_DROPPED_LABEL) }).toEqual({
        type,
        dropped: false,
      });
      const threads = (
        html.match(new RegExp(`data-testid="wall-context-${CEILING_THREAD_KIND}"`, 'g')) ?? []
      ).length;
      expect({ type, threads }).toEqual({ type, threads: 1 });
    }
  });

  it('is byte-reproducible, so a dated sign-off keeps meaning something', () => {
    jest.setSystemTime(CERT_CLOCK);
    const second = renderAll();
    expect(digestOf(second)).toBe(digestOf(rendered));
  });

  it('the committed sign-off artifact is still what the renderers produce', () => {
    const digest = digestOf(rendered);
    const page = buildPage(rendered, css, digest);
    if (EMIT) {
      writeFileSync(ARTIFACT, page, 'utf8');
    }
    expect(existsSync(ARTIFACT)).toBe(true);
    const committed = readFileSync(ARTIFACT, 'utf8');
    const found = committed.match(new RegExp(`${DIGEST_MARKER}([0-9a-f]+)`))?.[1] ?? '(none)';
    if (found !== digest) {
      throw new Error(
        `The Wall object renderers have changed since the certification render set was emitted.\n` +
          `  committed artifact digest: ${found}\n` +
          `  current render digest:     ${digest}\n` +
          `Any W159 / W167 design sign-off recorded against the committed page is now VOID — it\n` +
          `describes markup that is no longer what ships. Re-emit and re-run the review:\n` +
          `  cd travel-buddy-standalone && WALL_CERT_EMIT=1 npx jest -c jest.web.config.js WallCertRenderSet\n` +
          `then re-date the sign-off in docs/architecture/wall-certification-packet.md.`,
      );
    }
    expect(found).toBe(digest);
  });
});
