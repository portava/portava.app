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
