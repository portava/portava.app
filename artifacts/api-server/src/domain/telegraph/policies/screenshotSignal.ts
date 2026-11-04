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

// ── Wave 5 (census-telegraph T408, 2026-10-17): an ALLOWLIST of approved copy ──
//
// The latest statement of T408 keeps it W for one reason: the COPY half is a
// keyword pattern, so a sentence that promises protection without its keywords
// ("No one can capture this chat", "Snapshots are blocked in this
// conversation", "This chat is capture-protected") passed both it and the
// guarantee deny-list. Two changes, one of each kind:
//
//   1. AT A DETECTION SITE, AN ALLOWLIST — paraphrase-proof by construction.
//      §30A.9's subject is screenshot DETECTION, and detection can only exist
//      where a capture API is called, which the API scan confines to the
//      declared `SCREENSHOT_SIGNAL_SITES` (every shippable file of both trees is
//      read). Every user-facing string in a declared site must be EXACTLY one of
//      `APPROVED_SCREEN_CAPTURE_COPY`. Not a pattern of forbidden words: a list
//      of permitted sentences, so any new wording — whatever words it uses — is
//      red until a reviewer adds it, with the reason it is informational.
//   2. EVERYWHERE ELSE, A WIDER NET, STILL A NET. A string that pairs a
//      protection term with a copying term (`claimsCaptureProtection`) is a
//      claim-shaped string; every one in the client's copy, the rendered
//      notification templates and the API's route messages (log calls aside)
//      must be on `REVIEWED_CLAIM_SHAPED_COPY`. It catches the three paraphrases
//      above and their kin. It is lexical: a sentence with neither kind of word
//      ("what is shared here stays here") passes it — stated, not implied.

/** One sentence a screenshot-signal site may show. `{name}` is the only substitution. */
export interface ApprovedScreenCaptureCopy {
  readonly key: string;
  readonly text: string;
  readonly why: string;
}

/**
 * The ONLY sentences a declared screenshot-signal site may show. Closed: a site
 * that renders anything else is red, in any words.
 */
export const APPROVED_SCREEN_CAPTURE_COPY: readonly ApprovedScreenCaptureCopy[] = [
  {
    key: "took_screenshot",
    text: "{name} took a screenshot",
    why: "The signal itself, stated as something that happened — §30A.9's 'informational'. It promises nothing about what follows.",
  },
  {
    key: "alerts_are_informational",
    text: "Screenshot alerts are informational. They don’t stop anyone saving what you send.",
    why: "The disclaimer §30A.9 requires wherever the signal is explained: the alert is not a guarantee against copying.",
  },
];

const COPY_SHAPED = /\s/;
const MODULE_SPECIFIER = /^(?:[@.]|[a-z0-9-]+\/|node:)|^[a-z0-9_.-]+$/;

/**
 * The user-facing strings in a site's code that are NOT approved: every string
 * literal and JSX text that could be copy — it has whitespace, or starts with a
 * capital letter — other than an approved sentence. Module specifiers and bare
 * identifiers are not copy.
 */
export function unapprovedSiteCopy(code: string): string[] {
  const approved = new Set(APPROVED_SCREEN_CAPTURE_COPY.map((c) => c.text));
  const candidates = [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]!);
  for (const m of code.matchAll(/>([^<>{}=]+)</g)) {
    const t = m[1]!.trim();
    if (t.length > 0) candidates.push(t);
  }
  return candidates
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => !/;|=>|\breturn\b/.test(t)) // JSX-text matches that are code between an arrow's `>` and a tag
    .filter((t) => t.length > 0 && (COPY_SHAPED.test(t) || /^[A-Z]/.test(t)) && !MODULE_SPECIFIER.test(t) && !approved.has(t));
}

/** A term that presents something as stopped, refused, locked or protected. */
export const CAPTURE_PROTECTION_TERM = /\b(?:block(?:ed|s|ing)?|prevent(?:ed|s|ing)?|stop(?:s|ped|ping)?|disabled?|disallow(?:ed)?|not (?:allowed|possible|permitted)|can['’]?t|cannot|can not|unable|no ?one can|nobody can|impossible|protect(?:ed|ion|s|ing)?|secur(?:e|ed|ity)|safe from|proof|lock(?:ed|s)?|turned off|is off|are off|forbidden|prohibited)\b/i;
/** A term in the field of copying what is on a screen. */
export const COPYING_FIELD_TERM = /\b(?:screens?|screen ?shots?|captur(?:e|es|ed|ing)|snap ?shots?|cop(?:y|ied|ying|ies)|record(?:ed|ing|s)?|grab(?:bed|s|bing)?|print ?screen)\b/i;

/** A claim-shaped string: a protection term and a copying term together. */
export function claimsCaptureProtection(text: string): boolean {
  return CAPTURE_PROTECTION_TERM.test(text) && COPYING_FIELD_TERM.test(text);
}

/**
 * Every claim-shaped string in the client's shipped copy, the rendered
 * notification templates and the API's route messages, reviewed: none is about
 * the app stopping someone from capturing a conversation. Closed both ways — a
 * new one is red, a stale one is red.
 */
export const REVIEWED_CLAIM_SHAPED_COPY: readonly { readonly text: string; readonly why: string }[] = [
  { text: "This feature is turned off. Nothing is being captured.", why: "Intelligence capture (the app's own data collection) is off — about what the app records, not about anyone copying a conversation." },
  { text: "YYZ: domestic-to-international connections need a security re-screen.", why: "Airport security screening at a connection — 'screen' as in a security check." },
  { text: "Payments made outside the app have no booking record and no protection.", why: "Payment-safety warning: an off-app payment has no booking record and no buyer protection." },
  { text: "Capture is turned off right now.", why: "Intelligence capture switched off — the app's own collection, not screen capture." },
  { text: "This build cannot delete a recording after use, so it does not record.", why: "Voice capture is not offered because this build cannot delete the recording — a statement about the app's own recording." },
  { text: "Stop recording", why: "The button that ends the person's OWN voice-message recording." },
  { text: "gem copy contains forbidden hype language: ${hits.join(', ')} in \"${text}\"", why: "A developer assertion about marketing wording ('copy' as in text); never shown as a promise about capture." },
  { text: "via useRentABuddyFlag — shows a \"COMING SOON\" screen when the flag is off", why: "A route-table description: an app screen shown while a feature flag is off." },
  { text: "You will stop appearing in the ${group.label} circle. You can turn it back on from the ${group.contextType} detail screen.", why: "Circle visibility: the person stops appearing in a circle; 'screen' is an app screen." },
  { text: "Off — your signals won't contribute, and capture stays disabled until you turn this on. On: ${offered.summary}", why: "Intelligence-prompt setting: the app's own collection stays off — not screen capture." },
  { text: "Live intel capture is currently turned off, so no prompts appear. These preferences are saved and take effect if it’s enabled.", why: "Intelligence capture switched off — the app's own collection." },
  { text: "Portava can take a coarse loudness and rhythm reading to tell whether a place is lively. It measures a level only — no audio is recorded, kept or sent — and it is off until you turn it on here, separately from the microphone used for calls and video.", why: "The microphone-permission explanation for ambient-loudness sensing: what the app itself records (nothing), not a promise about anyone copying a conversation." },
  { text: "This starts a new group. Your conversation here stays private: nothing from it is copied, and the people you add cannot read it.", why: "census-telegraph T212 (batch 2): the Add people sheet on a DM, shown before anything is sent. It is about what the SERVER does when a group is formed from a DM (3660 copies no message into the new group, and the new members are never members of the DM), not about anyone copying what is on a screen." },
  ...reviewedRouteMessages()];

/**
 * Pass 13 (2026-10-18): the claim-shaped messages of the API's routes
 * (src/routes; a logger call's arguments are not read, as they never reach the
 * wire), reviewed onto `REVIEWED_CLAIM_SHAPED_COPY` above. A route's message is
 * copy: a client card shows it verbatim. None is about capture — each pairs
 * "record" or "snapshot" with "cannot" or "off", about Portava's OWN storage.
 * A function, not a const, so that the list above spreads it in without moving
 * a cited line: a function declaration is hoisted.
 */
function reviewedRouteMessages(): { text: string; why: string }[] {
  return [
    { text: "This Memory snapshot cannot be replayed safely right now.", why: "The degraded refusal of the owner's own Memory snapshot routes (MemorySnapshot.ts refuse(), behind requireUser; no shipped client calls them today): a snapshot is a stored version of the person's own Memory, and it cannot be replayed while the server is degraded. Nothing about anyone capturing a screen or a conversation." },
    { text: "This report names no accountable user, so this queue cannot record an action on it. Nothing was changed.", why: "Admin-only, not traveller copy: the 409 of POST /admin/moderation/reports/:id/review, behind requireAdmin. 'Record' is the moderation queue recording an action against a user." },
    { text: "${c.kind} cannot be recorded on its own: ${UNSUPPORTED_CONTRIBUTION_KINDS.media}", why: "The map contribution refusal for a bare photo, shown on the contribution sheet (map-contribution-detail): Portava will not store a photo as a claim until it names the observation it supports. 'Recorded' is the app's own storage of a report, not screen capture." },
    { text: "${c.kind} cannot be recorded yet: ${why}", why: "The map contribution refusal for a prompt with no canonical claim type, shown on the contribution sheet: Portava cannot store that kind of report yet. About the app's own storage, not about anyone copying a screen." },
    { text: "${TRIP_KERNEL_FLAG} is off: an outcome is recorded only through the kernel", why: "The closeout-answer refusal while trip_kernel_enabled is off, shown on the closeout card as 'Not recorded — TRIP_KERNEL_UNAVAILABLE: …': the trip outcome is not stored. 'Off' is a feature flag and 'recorded' is the app's own write, not screen capture." },
  ];
}
