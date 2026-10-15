/**
 * What the optional AI summary SENDS, in plain words, field by field — shown
 * beside the opt-in switch (census-highlights-memories H172; open owner
 * questions Q-NARR-2 and Q-NARR-6).
 *
 * The list is the server's payload, not a description of it: one entry per key
 * of `NarrativeAiFacts` (artifacts/api-server/src/services/memory/memoryNarrative.ts),
 * which `buildNarrativeAiMessages` sends as the model's only Memory input, null
 * facts omitted. A test reads that interface from the server source and fails
 * when the two disagree, so a fact added to the payload cannot reach the model
 * while this screen still says it is not sent.
 *
 * This is the app's restatement. The text a grant is RECORDED against is the
 * server's own disclosure (`disclosureText`, versioned), which the panel shows
 * verbatim; its wording is an engineering draft awaiting legal review (Q-NARR-6).
 */

/** The keys of the server's `NarrativeAiFacts`, in the order the panel lists them. */
export const NARRATIVE_AI_SENT_KEYS = ['title', 'caption', 'date', 'place', 'photos', 'people'] as const;
export type NarrativeAiSentKey = (typeof NARRATIVE_AI_SENT_KEYS)[number];

export const NARRATIVE_AI_SENT_LABELS: Readonly<Record<NarrativeAiSentKey, string>> = {
  title: 'Your title, as you wrote it',
  caption: 'Your caption, as you wrote it',
  date: 'The date it happened, only as precisely as the Memory records it',
  place: 'The city and country as stored with this Memory (less, or none, if its location is set to show less)',
  // The server counts every item on the Memory, photo or video, and sends one number.
  photos: 'How many photos and videos it holds, as one number',
  // Approved tags only, as a number: never who.
  people: 'How many people you tagged who accepted the tag, as a number, never who',
};

/** What is never sent — the payload's exclusions, as the server's tests pin them. */
export const NARRATIVE_AI_NEVER_SENT: readonly string[] = [
  'Map coordinates',
  'The names of the people you tagged',
  'Photo captions',
  "Anything someone else wrote",
];

/**
 * The owner's settings that keep a Memory from the model (the server's
 * NARRATIVE_AI_EXCLUDING_CONTROLS), in the words the app's privacy sheet uses
 * for them (src/features/highlights/HighlightPrivacySheet.tsx CONTROL_LABELS).
 */
export const NARRATIVE_AI_CONTROL_LABELS: Readonly<Record<string, string>> = {
  DO_NOT_RESURFACE: 'Don’t resurface this',
  KEEP_PRIVATE_FOREVER: 'Keep private forever',
  RETAIN_BUT_DO_NOT_PERSONALIZE: 'Keep, but don’t personalise from it',
};

/** The server's NARRATIVE_AI_EXCLUDING_CONTROLS, said once beside the switch. */
export const NARRATIVE_AI_NEVER_SENT_MEMORIES =
  `Memories set to “${NARRATIVE_AI_CONTROL_LABELS.DO_NOT_RESURFACE}”, “${NARRATIVE_AI_CONTROL_LABELS.KEEP_PRIVATE_FOREVER}” ` +
  `or “${NARRATIVE_AI_CONTROL_LABELS.RETAIN_BUT_DO_NOT_PERSONALIZE}” are never sent.`;

/** "This Memory is set to “Keep private forever”, so it is not sent to the AI." */
export function excludedByControlText(controls: readonly string[]): string {
  const names = controls.map((c) => NARRATIVE_AI_CONTROL_LABELS[c]).filter((n): n is string => typeof n === 'string');
  if (names.length === 0) return "This Memory's privacy settings keep it from the AI.";
  return `This Memory is set to ${names.map((n) => `“${n}”`).join(' and ')}, so it is not sent to the AI.`;
}

/**
 * Why there is no AI draft, when the server served the summary instead. Never a
 * guess at what the draft said: the server returns only the reason, and the app
 * shows only this sentence and the summary built from the Memory's own facts.
 */
const FALLBACK_REASON_TEXT: Readonly<Record<string, string>> = {
  model_unavailable: "The AI service didn't answer, so there is no draft.",
  empty_output: 'The AI service returned no draft.',
  too_long: 'The AI draft was too long, so it is not shown.',
  altered_owner_text: 'The AI draft changed your own words, so it is not shown.',
  unsupported_fact: "The AI draft said something this Memory's details don't support, so it is not shown.",
};

export function fallbackText(reason: string): string {
  const why = FALLBACK_REASON_TEXT[reason] ?? 'There is no AI draft for this Memory right now.';
  return `${why} Your summary is built from this Memory's own details.`;
}
