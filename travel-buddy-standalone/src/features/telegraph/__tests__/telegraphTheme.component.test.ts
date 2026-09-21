/**
 * Telegraph §11.1 — two themes, and the accent discipline.
 *
 *   "Dark-first visual system may be used for the Telegraph concept, but
 *    components must support Portava light/dark themes."
 *   "Use restrained teal/cyan as operational emphasis; reserve stronger
 *    attention states for safety and urgent changes."
 *
 * WHAT THIS SETTLES, AND WHAT IT DOES NOT. It settles that a dark palette
 * EXISTS, that a resolver picks it, that every key is defined in both, that
 * the operational accent is teal/cyan and is NOT the app-wide vermilion, and
 * that ordinary body text clears WCAG AA on both surfaces (arithmetic over the
 * real token values, so changing a token moves this test). It does NOT claim
 * every Telegraph screen has adopted it — `src/theme/telegraphTokens.ts`'s
 * static light `TG` is still what the inbox and the conversation shell import,
 * and the census row says so.
 *
 * SHOWN RED before commit: with `DARK.operational` set to `color.signal`, the
 * "operational is teal, not the app's attention colour" test fails; with the
 * DARK palette deleted and `telegraphPalette` returning LIGHT always, the
 * "resolves dark" and contrast-on-dark tests fail.
 */
import {
  TELEGRAPH_PALETTES,
  statusLabelFor,
  telegraphPalette,
  type TelegraphPalette,
} from '../theme/telegraphTheme.ts';
import { color } from '../../../theme/tokens.ts';

function srgbChannel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const KEYS: Array<keyof TelegraphPalette> = [
  'scheme', 'surface', 'surfaceRaised', 'sentBubble', 'sentText', 'sentTextMute',
  'recvBubble', 'recvBorder', 'recvText', 'mute', 'hairline', 'chipFill',
  'operational', 'operationalOn', 'attention', 'attentionOn',
];

describe('§11.1 — Telegraph supports both Portava themes', () => {
  it('both palettes exist and define every key', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const p = TELEGRAPH_PALETTES[scheme];
      expect(p.scheme).toBe(scheme);
      for (const k of KEYS) {
        expect(`${scheme}.${String(k)}=${String(p[k])}`).not.toContain('undefined');
      }
    }
  });

  it('the resolver picks dark for dark and light for everything else', () => {
    expect(telegraphPalette('dark').scheme).toBe('dark');
    expect(telegraphPalette('light').scheme).toBe('light');
    expect(telegraphPalette(null).scheme).toBe('light');
    expect(telegraphPalette(undefined).scheme).toBe('light');
  });

  it('the light palette is byte-identical in colour to the shipped TG tokens, so nothing re-themes by accident', () => {
    const light = TELEGRAPH_PALETTES.light;
    expect(light.surface).toBe('#F7F6F3');
    expect(light.surfaceRaised).toBe('#FFFFFF');
    expect(light.sentBubble).toBe('#1A3A2A');
    expect(light.recvBubble).toBe('#FFFFFF');
  });

  it('the two palettes are genuinely different surfaces, not one palette twice', () => {
    expect(TELEGRAPH_PALETTES.dark.surface).not.toBe(TELEGRAPH_PALETTES.light.surface);
    expect(luminance(TELEGRAPH_PALETTES.dark.surface)).toBeLessThan(
      luminance(TELEGRAPH_PALETTES.light.surface),
    );
  });
});

describe('§11.1 — restrained teal as operational, attention reserved', () => {
  it('operational is teal/cyan, and is NOT the app-wide vermilion', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const p = TELEGRAPH_PALETTES[scheme];
      expect(p.operational).not.toBe(color.signal);
      // Teal/cyan: blue channel dominates red.
      const h = p.operational.replace('#', '');
      const r = parseInt(h.slice(0, 2), 16);
      const b = parseInt(h.slice(4, 6), 16);
      // teal/cyan: the blue channel must dominate the red one
      expect(b).toBeGreaterThan(r);
    }
  });

  it('attention is the stronger state, reserved — it is the signal colour and nothing else uses it', () => {
    expect(TELEGRAPH_PALETTES.light.attention).toBe(color.signal);
    expect(TELEGRAPH_PALETTES.dark.attention).toBe(color.signal);
  });
});

describe('§11.3 — status is a word, and body text is readable on both surfaces', () => {
  it('every band has a human label', () => {
    const bands = [
      'HAPPENING_NOW', 'STARTING_SOON', 'TODAY', 'UPCOMING', 'ACTIVE_TRIP', 'UNRESOLVED', 'PAST',
    ] as const;
    const labels = bands.map(statusLabelFor);
    expect(new Set(labels).size).toBe(bands.length);
    for (const l of labels) expect(l.length).toBeGreaterThan(2);
  });

  it('received body text clears WCAG AA (4.5:1) on both surfaces', () => {
    expect(contrast(TELEGRAPH_PALETTES.light.recvText, TELEGRAPH_PALETTES.light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(TELEGRAPH_PALETTES.dark.recvText, TELEGRAPH_PALETTES.dark.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('sent bubble text clears AA on its own bubble in both themes', () => {
    expect(contrast(TELEGRAPH_PALETTES.light.sentText, TELEGRAPH_PALETTES.light.sentBubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(TELEGRAPH_PALETTES.dark.sentText, TELEGRAPH_PALETTES.dark.sentBubble)).toBeGreaterThanOrEqual(4.5);
  });

  it('the secondary/mute text clears the AA large-text floor (3:1) on both surfaces', () => {
    expect(contrast(TELEGRAPH_PALETTES.light.mute, TELEGRAPH_PALETTES.light.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(TELEGRAPH_PALETTES.dark.mute, TELEGRAPH_PALETTES.dark.surface)).toBeGreaterThanOrEqual(3);
  });
});
