/**
 * Telegraph §30A.9 — screenshot detection is informational only.
 *
 * Spec §30A.9, verbatim:
 *   "Screenshot detection, if later supported by a platform, is informational
 *    only and is never presented as a guarantee against copying."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * census-telegraph T408: "No screenshot detection." An UNGUARDED absence: the
 * rule constrains a feature that does not exist yet, and nothing in the tree
 * would notice the feature arriving in the form the rule forbids — a
 * `preventScreenCaptureAsync()` call shipped behind a "screenshots are blocked
 * in this chat" banner, which is a promise no platform can keep (a second
 * phone's camera defeats every one of them).
 *
 * ── WHAT IS GUARDED, AS DATA ────────────────────────────────────────────────
 * `src/test/telegraphScreenshotInformational.test.ts` enforces, over both trees:
 *
 *   1. Every use of a screenshot DETECTION or PREVENTION API, and every
 *      dependency that provides one, is in `SCREENSHOT_SIGNAL_SITES`. The list
 *      is EMPTY: today there is no detection, which is the honest state for a
 *      clause that begins "if later supported".
 *   2. A site on that list must declare `presentation: "informational"` — the
 *      type admits nothing else — and the copy it draws must not be on the
 *      guarantee list below.
 *   3. No user-facing string anywhere in the client presents screenshotting as
 *      blocked, prevented or impossible.
 *
 * So the feature can still be built; it just has to be built as a signal
 * ("Alex took a screenshot"), never as a lock.
 */

/** APIs and packages that detect or try to prevent screen capture. */
export const SCREENSHOT_CAPTURE_APIS = [
  "expo-screen-capture",
  "addScreenshotListener",
  "removeScreenshotListener",
  "preventScreenCaptureAsync",
  "allowScreenCaptureAsync",
  "usePreventScreenCapture",
  "isAvailableAsync({ screenCapture",
  "FLAG_SECURE",
  "userDidTakeScreenshotNotification",
  "capturedDidChangeNotification",
  "react-native-screenshot-prevent",
  "react-native-capture-protection",
  "react-native-screen-capture-secure",
  // lane T, 2026-10-07: more of the published capture-prevention packages, and Android's own flag spelled as code.
  "react-native-screenguard",
  "react-native-prevent-screenshot",
  "react-native-screenshot-detect",
  "react-native-detector",
  "LayoutParams.FLAG_SECURE",
] as const;

export interface ScreenshotSignalSite {
  /** Repo-relative client module. */
  readonly file: string;
  /** The ONLY presentation §30A.9 admits. */
  readonly presentation: "informational";
  readonly note: string;
}

/** Closed list. Empty: there is no screenshot detection in either tree. */
export const SCREENSHOT_SIGNAL_SITES: readonly ScreenshotSignalSite[] = [];

/**
 * Copy that presents screen capture as blocked, prevented or impossible — a
 * guarantee §30A.9 forbids. Informational copy ("took a screenshot") is not on
 * the list and stays allowed.
 */
export const SCREENSHOT_GUARANTEE_COPY: readonly RegExp[] = [
  /screen ?shots? (?:are|is|will be|have been) (?:blocked|prevented|disabled|disallowed|not (?:allowed|possible|permitted))/i,
  /(?:can ?not|can['’]t|cannot|unable to) (?:be )?(?:screen ?shot|take (?:a )?screen ?shots?|capture (?:this|the) screen)/i,
  /screen ?shot[- ]?(?:proof|protected|protection|safe)/i,
  /(?:prevents?|blocks?|stops?) (?:any(?:one)? (?:from )?(?:taking )?)?screen ?shots?/i,
  /protected (?:from|against) (?:screen ?shots?|screen capture|copying)/i,
  /no one can (?:take a )?screen ?shot/i,
];

/** True when `text` presents screen capture as something the app prevents. */
export function isScreenshotGuarantee(text: string): boolean {
  return SCREENSHOT_GUARANTEE_COPY.some((re) => re.test(text));
}

/** The capture APIs `code` uses, by literal name. */
export function screenshotApisIn(code: string): string[] {
  return SCREENSHOT_CAPTURE_APIS.filter((api) => code.includes(api));
}

// ── Hardening (lane T, mission 4, 2026-10-07): census-telegraph §45c ────────
//
// §45c moved T408 back to W: "A deny-list a paraphrase gets past is not C" —
// "Screenshots aren't allowed in this chat" and "Screen capture is disabled for
// this conversation" passed SCREENSHOT_GUARANTEE_COPY — "and an Expo config
// plugin injecting FLAG_SECURE would sit outside the scan (src/ and app/
// .ts/.tsx only; plugins/, the app config, .js and server templates are not
// read)." Two structural answers:
//
//   1. COPY: every user-facing string that MENTIONS screen capture at all — in
//      either tree, in any paraphrase — is on a closed list, each entry with
//      the reason it is informational. A new mention is red until a reviewer
//      lists it; the deny-list stays as a second check on the listed ones.
//   2. NATIVE AND CONFIG: the capture-API scan reads every text file of the
//      mobile package that can ship — the Expo config, config plugins, native
//      sources, vendored modules, server templates, .js as well as .ts — and
//      the server package's non-TypeScript files too.

/** A mention of screen capture, in any words. Deliberately broad: it is a review gate, not a verdict. */
export const SCREEN_CAPTURE_MENTION = /\b(?:screen[- ]?shot|screen[- ]?capture|screen[- ]?record|screen[- ]?grab|print[- ]?screen|capture (?:this|the|your) screen)/i;

export function mentionsScreenCapture(text: string): boolean {
  return SCREEN_CAPTURE_MENTION.test(text);
}

export interface ScreenCaptureMention {
  /** The exact string (whitespace collapsed). */
  readonly text: string;
  readonly tree: "client" | "server";
  /** Why it is informational, not a guarantee. */
  readonly why: string;
}

/**
 * Closed list: every string in either tree that mentions screen capture. None
 * of them claims the app prevents or detects it.
 */
export const SCREEN_CAPTURE_MENTIONS: readonly ScreenCaptureMention[] = [
  {
    text: "A transferred screenshot is not a ticket. Buy through the venue or the official reseller.",
    tree: "client",
    why: "Ticket-scam advice in the message safety banner: a screenshot is the thing a scammer sends, not something the app blocks.",
  },
  {
    text: "screenshot",
    tree: "server",
    why: "A media provenance value (a capture of a screen, not of the world) used by media ranking, memory evidence and certification.",
  },
  {
    text: "all media is screenshot/downloaded/imported and nothing else attests occurrence",
    tree: "server",
    why: "A memory-evidence reason: media of that provenance does not attest an experience.",
  },
  {
    text: "SCREENSHOT_NOT_EXPERIENCED",
    tree: "server",
    why: "A memory-certification fixture id.",
  },
  // services/memoryCertification/fixtures.ts — certification fixtures about screenshot PROVENANCE, not about the app.
  {
    text: "Downloaded screenshot that must not become experienced content.",
    tree: "server",
    why: "Memory-certification fixture text: a screenshot is media that does not attest an experience.",
  },
  {
    text: "A screenshot saved from someone else's post. Its paired control is the SAME signal with capture_provenance 'camera', so the gate has to read provenance rather than count media.",
    tree: "server",
    why: "Memory-certification fixture text describing a provenance case.",
  },
  {
    text: "screenshot-1",
    tree: "server",
    why: "A memory-certification fixture media id.",
  },
  {
    text: "One image whose provenance is `screenshot`. §25 names this exactly: a downloaded screenshot must not become experienced content. The paired control is the same signal with provenance `camera`, which must be eligible — so the gate is reading provenance and not counting media.",
    tree: "server",
    why: "Memory-certification fixture text describing a provenance case.",
  },
];
