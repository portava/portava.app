/**
 * Telegraph §6.1 — the composer's `+` menu, as data.
 *
 * Spec §6.1:
 *   [ + ]  Message…                         [🎤]
 *   + menu:  Camera   Photos
 *            Video    GIF
 *            Voice    Memory Note
 *            Location Portava
 *
 *   "The composer remains visually calm; rich actions live behind the + menu."
 *
 * WHY THIS IS DATA AND NOT JSX. §6.1 names EIGHT entries. Four of them are
 * wired to a real flow, three are wired to a §6.2 typed kind, and ONE — Voice —
 * cannot work in this tree, because `messages.media_type` is constrained to
 * ('image','video') and `lib/mediaPipeline.ts` admits image and video MIME
 * types only. An entry that opens a picker whose result cannot be sent is
 * worse than an entry that says why: the traveler records thirty seconds of
 * audio and then loses it.
 *
 * So each entry carries its OWN availability and its OWN reason, the menu
 * renders a disabled entry with that reason, and the census row can cite this
 * list rather than a screenshot. When the audio migration lands, one field
 * changes here.
 */
export type ComposerEntryId =
  | 'CAMERA'
  | 'PHOTOS'
  | 'VIDEO'
  | 'GIF'
  | 'VOICE'
  | 'MEMORY_NOTE'
  | 'LOCATION'
  | 'PORTAVA';

export interface ComposerEntry {
  id: ComposerEntryId;
  label: string;
  /** Which §6.2 kind this entry produces, where it produces one. */
  kind: string | null;
  /** False when the entry cannot complete in this tree. */
  available: boolean;
  /** Why not. Shown to the user, and read by the census. */
  unavailableReason: string | null;
}

/** §6.1's eight, in the spec's two-column reading order. */
export const COMPOSER_ENTRIES: readonly ComposerEntry[] = [
  { id: 'CAMERA', label: 'Camera', kind: 'IMAGE', available: true, unavailableReason: null },
  { id: 'PHOTOS', label: 'Photos', kind: 'IMAGE', available: true, unavailableReason: null },
  { id: 'VIDEO', label: 'Video', kind: 'VIDEO', available: true, unavailableReason: null },
  {
    id: 'GIF',
    label: 'GIF',
    kind: 'GIF',
    available: false,
    unavailableReason:
      'No GIF provider is configured in this build. The GIF message kind exists and renders (with a still frame under reduced motion or data saver); what is missing is a picker to choose one from.',
  },
  {
    id: 'VOICE',
    label: 'Voice',
    kind: 'VOICE',
    available: false,
    unavailableReason:
      'Voice messages need an audio asset type. messages.media_type allows only image and video, so there is nowhere to store the recording yet.',
  },
  { id: 'MEMORY_NOTE', label: 'Memory Note', kind: 'MEMORY_NOTE', available: true, unavailableReason: null },
  { id: 'LOCATION', label: 'Location', kind: 'LOCATION', available: true, unavailableReason: null },
  {
    id: 'PORTAVA',
    label: 'Portava',
    kind: 'PORTAVA_OBJECT',
    available: false,
    unavailableReason:
      'Sharing a Portava object into a thread works end to end on the server (POST /threads/:id/share) and the card renders and revokes correctly; what is missing is an in-composer object picker to choose WHICH object.',
  },
] as const;

export function composerEntry(id: ComposerEntryId): ComposerEntry {
  const found = COMPOSER_ENTRIES.find((e) => e.id === id);
  if (!found) throw new Error(`unknown composer entry: ${id}`);
  return found;
}

/** How many of §6.1's eight a traveler can actually complete today. */
export function availableEntryCount(): number {
  return COMPOSER_ENTRIES.filter((e) => e.available).length;
}
