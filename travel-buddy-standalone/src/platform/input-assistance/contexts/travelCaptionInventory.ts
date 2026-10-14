/**
 * §50 inventory rows for the two caption fields census-input-intelligence G141
 * added: `postcard.caption` and `memory.caption` (both under the existing
 * `caption` context, registered by `compass/compassFields.ts`).
 *
 * They live here, and are spread into `FIELD_INVENTORY` on one existing line,
 * so that no line-cited row of `fieldInventory.ts` moves. They are ordinary
 * `FieldInventoryRecord`s: `fieldInventoryRow` merges the registry's half in,
 * and `inputAssistanceFieldInventory.test.ts` holds them to the same rules as
 * every other row (registered, component file on disk, `mounted` measured by
 * the screens that name the field).
 *
 * Pure module — no React, no network.
 */
import type { FieldInventoryRecord } from './fieldInventory.ts';

export const TRAVEL_CAPTION_INVENTORY: readonly FieldInventoryRecord[] = [
  {
    fieldId: 'postcard.caption',
    context: 'caption',
    screenRoute: '/(tabs)/passport — Add postcard',
    componentFile: 'travel-buddy-standalone/src/components/PostcardComposer.tsx',
    currentImplementation:
      'CaptionAiAssist under the caption: one tap sends that caption, and nothing else, through useAiWritingAssist with AI-only capabilities; the server drops any proposal holding a word the traveller did not write (lib/inputAssistance/travelWriting.ts).',
    provider: 'OpenAI via the existing Compass model path (gpt-5-mini)',
    zeroState: 'None. Nothing is requested until the traveller taps "Suggest with AI".',
    validation: "Server, on every proposal: the traveller's own words plus a closed connecting/feeling vocabulary (travelWriting.ts#inventedFacts).",
    knownIssues: [
      'Inert on every deployment while compass_ai_writing_enabled is OFF: the button does not render.',
      "The connecting vocabulary is English: a polish in another language passes only when it reuses the traveller's own words.",
    ],
    migrationStatus: 'mounted',
  },
  {
    fieldId: 'memory.caption',
    context: 'caption',
    screenRoute: '/memory/new, /memory/edit',
    componentFile: 'travel-buddy-standalone/app/memory/new.tsx',
    currentImplementation:
      "CaptionAiAssist under the caption on both Memory screens, as postcard.caption. The edit screen also sends the Memory's id: the server refuses a Memory that is not the caller's, is deleted, or carries DO_NOT_RESURFACE / KEEP_PRIVATE_FOREVER / RETAIN_BUT_DO_NOT_PERSONALIZE.",
    provider: 'OpenAI via the existing Compass model path (gpt-5-mini)',
    zeroState: 'None. Nothing is requested until the traveller taps "Suggest with AI".',
    validation: "Server, on every proposal: the traveller's own words plus a closed connecting/feeling vocabulary (travelWriting.ts#inventedFacts).",
    knownIssues: [
      'Inert on every deployment while compass_ai_writing_enabled is OFF: the button does not render.',
      "The connecting vocabulary is English: a polish in another language passes only when it reuses the traveller's own words.",
    ],
    migrationStatus: 'mounted',
  },
];
