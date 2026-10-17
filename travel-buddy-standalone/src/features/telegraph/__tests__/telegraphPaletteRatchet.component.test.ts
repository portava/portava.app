/**
 * census-telegraph T123 / T124 — the palette RATCHET. Source-level, over every
 * Telegraph module, so a regression is a red test rather than a screen someone
 * has to open in dark mode.
 *
 *   T123 §11.1 "components must support Portava light/dark themes"
 *     R1  nothing imports the static single light palette (`TG`, `TG_META`,
 *         `TG_PILL` from theme/telegraphTokens.ts). Zero tolerance.
 *     R2  every Telegraph module reads its colours from the scheme's palette:
 *         no light-only app token (`color.ink`, `.mute`, `.faint`, `.haze`,
 *         `.paper`, `.paperRaised`, `.deep`, `.signal*`, `.success`) and no
 *         module-scope `StyleSheet.create` that could hold one. The only
 *         exceptions are LIGHT_HOSTED — modules drawn inside a shared host that
 *         is itself light-only — each with its reason and a CEILING that may
 *         only fall.
 *   T124 §11.1 "restrained teal/cyan as operational emphasis; reserve stronger
 *         attention states for safety and urgent changes"
 *     R3  the app's vermilion accent token (`color.signal`) appears in NO
 *         Telegraph module, light-hosted ones included;
 *     R4  the attention colour is used only by the modules named in ATTENTION,
 *         each with the safety / urgent-change reason it is there for.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...walk(rel));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** The Telegraph modules outside the feature folder — the census's twelve, and the tray they share a screen with. */
const COMPONENTS = [
  'app/messages/[id].tsx',
  'app/telegraph/new.tsx',
  'src/components/GroupChatScreen.tsx',
  'src/components/TelegraphInboxScreen.tsx',
  'src/components/MessageMediaBubble.tsx',
  'src/components/TelegraphSystemNotice.tsx',
  'src/components/TelegraphRecommendationCard.tsx',
  'src/components/CompassCardMessage.tsx',
  'src/components/DiscoveryCardMessage.tsx',
  'src/components/CircleStatusCardMessage.tsx',
  'src/components/PostCardMessage.tsx',
  'src/components/rentabuddy/BookingMilestoneMessage.tsx',
  'src/components/telegraph/TelegraphPrimitives.tsx',
  'src/components/TelegraphSuggestionTray.tsx',
  'src/components/TelegraphChatCard.tsx',
];

const TELEGRAPH = [...walk('src/features/telegraph'), ...COMPONENTS];

/** Modules drawn inside a shared host that is itself light-only: theming them would put light text on that light host. */
const LIGHT_HOSTED: Readonly<Record<string, { ceiling: number; why: string }>> = {
  'src/features/telegraph/savedMessages/SavedMessagesScreen.tsx': { ceiling: 14, why: 'its header is the shared AppHeader, which has no dark scheme' },
  'src/features/telegraph/components/DataSaverRow.tsx': { ceiling: 6, why: 'mounted inside the shared TranslationSettingsSheet, which has no dark scheme' },
  'src/features/telegraph/composer/PortavaTripShareSheet.tsx': { ceiling: 6, why: 'drawn inside the shared PortavaSheet, which has no dark scheme' },
  'app/telegraph/new.tsx': { ceiling: 15, why: 'its header is the shared AppHeader, which has no dark scheme' },
  // The palette's own definition names the tokens it maps from.
  'src/features/telegraph/theme/telegraphTheme.ts': { ceiling: 8, why: 'the light palette IS these tokens' },
  // A Passport-styled settings page (PP tokens) reached from Settings, under the settings stack's own header.
  'src/features/telegraph/settings/MessageSettingsScreen.tsx': { ceiling: 0, why: 'a Settings page drawn in the Passport palette (PP), which has no dark scheme' },
};

/** The attention colour (vermilion), and why each module may draw it. */
const ATTENTION: Readonly<Record<string, string>> = {
  'src/features/telegraph/sharedContext/SharedContextRail.tsx': 'urgent change: a promoted critical change on the rail',
  'src/features/telegraph/safety/SafetyModeBar.tsx': 'safety: a raised safety mode',
  'src/features/telegraph/kinds/TypedMessageRenderer.tsx': 'safety: the SAFETY message kind',
  'src/features/telegraph/coordination/CoordinationPanel.tsx': 'safety: NEED_HELP',
  'src/features/telegraph/voice/VoiceRecorderSheet.tsx': 'a recording that failed',
  'src/features/telegraph/voice/VoiceMessagePlayer.tsx': 'a voice note that could not play',
  'src/features/telegraph/messageActions/sheetStyles.ts': 'safety: the reason chosen in a report',
  'src/components/GroupChatScreen.tsx': 'safety: the reason chosen in a report',
  'app/messages/[id].tsx': 'safety: the reason chosen in a report',
};

const LIGHT_ONLY = /\bcolor\.(ink|mute|muteStrong|faint|haze|paper|paperRaised|deep|signal|signalDim|signalStrong|success)\b/g;
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('T123 — the static light palette is gone from Telegraph', () => {
  it('R0 the scan covers what it claims (not vacuous)', () => {
    expect(TELEGRAPH.length).toBeGreaterThan(100);
    for (const f of COMPONENTS) expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
  });

  it('R1 no module in the app imports TG, TG_META or TG_PILL', () => {
    const offenders: string[] = [];
    for (const f of [...walk('src'), ...walk('app')]) {
      if (f === 'src/theme/telegraphTokens.ts') continue;
      const src = read(f);
      for (const m of src.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*telegraphTokens(?:\.ts)?['"]/g)) {
        const names = m[2].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        for (const n of names) if (['TG', 'TG_META', 'TG_PILL'].includes(n)) offenders.push(`${f}: ${n}`);
      }
      if (/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*telegraphTokens/.test(src)) offenders.push(`${f}: namespace import`);
    }
    expect(offenders).toEqual([]);
  });

  it('R2 every Telegraph module draws from the palette: no light-only token, no module-scope sheet — except LIGHT_HOSTED, under its ceiling', () => {
    const offenders: string[] = [];
    const lower: string[] = [];
    for (const f of TELEGRAPH) {
      const src = strip(read(f));
      const n = (src.match(LIGHT_ONLY) ?? []).length;
      const hosted = LIGHT_HOSTED[f];
      if (hosted) {
        if (n > hosted.ceiling) offenders.push(`${f}: ${n} light-only tokens, ceiling ${hosted.ceiling} (${hosted.why})`);
        if (n < hosted.ceiling) lower.push(`${f}: ${n} < ceiling ${hosted.ceiling} — LOWER the ceiling so the gain is kept`);
        continue;
      }
      if (n > 0) offenders.push(`${f}: ${n} light-only token(s) — read the scheme's palette (useTelegraphTheme)`);
      // A module-scope sheet is ONE scheme. It may hold fixed, scheme-independent colours (a video
      // stage's black), never a palette's token.
      for (const [, name, body] of src.matchAll(/^const\s+(\w+)\s*=\s*StyleSheet\.create\(\{([\s\S]*?)^\}\);/gm)) {
        if (/\b(?:color|TG|PP)\.\w+/.test(body)) offenders.push(`${f}: module-scope sheet \`${name}\` holds a palette token — make it per scheme`);
      }
    }
    expect(offenders).toEqual([]);
    expect(lower).toEqual([]);
  });

  it('R2b every LIGHT_HOSTED entry is still a Telegraph module (no stale exemption)', () => {
    for (const f of Object.keys(LIGHT_HOSTED)) expect(TELEGRAPH).toContain(f);
  });
});

describe('T124 — vermilion means only safety and urgent change', () => {
  it('R3 the vermilion accent token is in no Telegraph module', () => {
    const offenders = TELEGRAPH.filter((f) => f !== 'src/features/telegraph/theme/telegraphTheme.ts')
      .filter((f) => /\bcolor\.signal\b(?![A-Za-z])/.test(strip(read(f))));
    expect(offenders).toEqual([]);
  });

  it('R4 the attention colour is drawn only where ATTENTION says why', () => {
    const users = TELEGRAPH.filter((f) => /\.attention(On)?\b/.test(strip(read(f)))).sort();
    expect(users).toEqual(Object.keys(ATTENTION).sort());
  });
});
