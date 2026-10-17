/**
 * Telegraph §6.1 → §6.2 — the small compose sheets behind two of the `+`
 * menu's entries.
 *
 *   Location    -> a §6.2 LOCATION message, COARSE by default (§4.3)
 *   Memory Note -> a §6.2 MEMORY_NOTE message (§10.1's MemoryNoteShare)
 *
 * §4.3's "approximate proximity or controlled distance buckets by default" is
 * enforced HERE, at the point of authorship: the precision selector opens on
 * "Approximate area", and choosing "Exact" is a deliberate second tap. Nothing
 * in this sheet reads the device's GPS — the label is what the sender types,
 * so an exact coordinate can only enter a thread through a surface that asked
 * for it explicitly.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import type { SendableKind } from '../kinds/kindsApi.ts';

export type TypedComposeKind = 'LOCATION' | 'LOCATION_SCOPE' | 'MEMORY_NOTE'; // LOCATION_SCOPE: census-telegraph T106 — §9 Active's "optional location scope", a TIME-LIMITED share (see the foot of this file)

export interface TypedComposePromptProps {
  kind: TypedComposeKind | null;
  onCancel: () => void;
  onSubmit: (kind: SendableKind, payload: unknown) => void;
  /** Used as MEMORY_NOTE's authorId; the server re-derives the sender anyway. */
  authorId: string | null; /** §54 (GII-F10): the "meet at" action's structured share, PRE-FILLED — the sender still presses Send. */ initialLocation?: { label: string; placeId: string | null; precision: 'area' | 'venue' | 'exact' } | null;
}

const PRECISIONS = [
  { id: 'area', label: 'Approximate area' },
  { id: 'venue', label: 'Venue' },
  { id: 'exact', label: 'Exact' },
] as const;

export function TypedComposePrompt({ kind, onCancel, onSubmit, authorId, initialLocation }: TypedComposePromptProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [text, setText] = useState('');
  const [precision, setPrecision] = useState<'area' | 'venue' | 'exact'>('area'); useEffect(() => { if (kind === 'LOCATION' && initialLocation) setText(initialLocation.label); }, [kind, initialLocation]); // §4.3: pre-filling the LABEL never pre-selects a finer precision — the sheet still opens on Approximate area

  const [minutes, setMinutes] = useState<number>(SCOPED_LOCATION_DEFAULT_MINUTES); // T106: how long a SCOPE share runs
  const scoped = kind === 'LOCATION_SCOPE';
  const locating = kind === 'LOCATION' || scoped;

  const close = () => {
    setText('');
    setPrecision('area');
    setMinutes(SCOPED_LOCATION_DEFAULT_MINUTES);
    onCancel();
  };

  const submit = () => {
    const value = text.trim();
    if (value.length === 0) return;
    if (scoped) {
      // §12 location_shares: purpose, precision and EXPIRY — the expiry is what makes this a share, not a pin.
      onSubmit('LOCATION', { label: value, precision, purpose: scopedLocationPurpose(precision), expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() });
    } else if (kind === 'LOCATION') {
      onSubmit('LOCATION', { label: value, precision, ...(initialLocation?.placeId && value === initialLocation.label ? { placeId: initialLocation.placeId } : {}) }); // an edited label no longer names that place, so its id is dropped
    } else {
      onSubmit('MEMORY_NOTE', {
        memoryNoteId: `note-${Date.now()}`,
        authorId: authorId ?? 'me',
        text: value,
        mediaAssetIds: [],
      });
    }
    setText('');
    setPrecision('area');
    setMinutes(SCOPED_LOCATION_DEFAULT_MINUTES);
  };

  return (
    <Modal visible={kind !== null} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="telegraph-typed-compose">
          <Text style={styles.heading}>
            {scoped ? 'Share where you are, for a limited time' : kind === 'LOCATION' ? 'Share a location' : 'Write a Memory Note'}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={scoped ? 'Where are you? e.g. An Thuong night market' : kind === 'LOCATION' ? 'Where? e.g. An Thuong' : 'What happened?'}
            placeholderTextColor={palette.mute}
            style={styles.input}
            multiline={kind === 'MEMORY_NOTE'}
            accessibilityLabel={locating ? 'Location label' : 'Memory note text'}
            testID="telegraph-typed-compose-input"
          />
          {locating ? (
            <View style={styles.row}>
              {PRECISIONS.map((p) => (
                <Pressable
                  key={p.id}
                  testID={`telegraph-precision-${p.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: precision === p.id }}
                  accessibilityLabel={p.label}
                  onPress={() => setPrecision(p.id)}
                  style={[styles.chip, precision === p.id ? styles.chipActive : null]}
                >
                  <Text style={[styles.chipText, precision === p.id ? styles.chipTextActive : null]}>
                    {p.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {scoped ? (
            <View style={styles.row} accessibilityLabel="How long to share">
              {SCOPED_LOCATION_MINUTES.map((m) => (
                <Pressable
                  key={m}
                  testID={`telegraph-location-duration-${m}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: minutes === m }}
                  accessibilityLabel={`Share for ${durationLabel(m)}`}
                  onPress={() => setMinutes(m)}
                  style={[styles.chip, minutes === m ? styles.chipActive : null]}
                >
                  <Text style={[styles.chipText, minutes === m ? styles.chipTextActive : null]}>{durationLabel(m)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {scoped ? <Text style={styles.note}>Ends by itself after {durationLabel(minutes)}.</Text> : null}
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={close} style={styles.secondary}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              onPress={submit}
              style={styles.primary}
              testID="telegraph-typed-compose-send"
            >
              <Text style={styles.primaryText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: p.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: space.lg,
      gap: space.md,
    },
    heading: { ...t.body, color: p.recvText, fontWeight: '800' },
    input: {
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.hairline,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      color: p.recvText,
      minHeight: 44,
    },
    row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
    chip: {
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: p.chipFill,
    },
    chipActive: { backgroundColor: p.operational },
    chipText: { ...t.small, color: p.mute },
    chipTextActive: { color: p.operationalOn, fontWeight: '700' },
    note: { ...t.small, color: p.mute },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
    secondary: { paddingHorizontal: space.lg, paddingVertical: 8 },
    secondaryText: { ...t.small, color: p.mute },
    primary: {
      paddingHorizontal: space.lg,
      paddingVertical: 8,
      borderRadius: radius.pill,
      backgroundColor: p.operational,
    },
    primaryText: { ...t.small, color: p.operationalOn, fontWeight: '700' },
  });
}

export default TypedComposePrompt;

// ── census-telegraph T106: the location SCOPE (§9 Active, "optional location scope") ──────────
//
// The coordination panel's and the safety bar's location-scope control used to open the place
// sheet above, which sends a pin — a label and a precision, no expiry, no purpose — and verifier F7
// had it relabelled "Share a place". A scope is a SHARE: §12 `location_shares` is
// "purpose/audience/precision/expiry scoped", the audience is the conversation, and the server
// treats `expiresAt` as what makes a LOCATION a share rather than a pin
// (`checkLocationShareWindow`: in the future, at most MAX_LOCATION_SHARE_HOURS; the lifecycle sweep
// ends it and emits location.expired). So the scope mode sends all four: the label at the
// precision chosen (Approximate area by default, §4.3 — "Exact" is still a deliberate tap), a
// purpose from the server's registry, and an expiry the sender picks from a short list that never
// passes the server's ceiling. Nothing here reads the device GPS: the position is what the sender
// says it is, at the precision they choose.

/** The server's ceiling (`MAX_LOCATION_SHARE_HOURS`, messageKinds.ts) — pinned equal by a cross-tree test. */
export const SCOPED_LOCATION_MAX_HOURS = 4;

/** The windows a sender may pick, in minutes; every one inside the ceiling. */
export const SCOPED_LOCATION_MINUTES: readonly number[] = [15, 60, 240];

/** One hour unless the sender picks otherwise. */
export const SCOPED_LOCATION_DEFAULT_MINUTES = 60;

/**
 * The registry purpose a scope share declares (`TELEGRAPH_SHARE_PURPOSES`): coarse "here, in this
 * context" for an area or a venue; the precise, session-bounded purpose for an exact position.
 */
export function scopedLocationPurpose(precision: 'area' | 'venue' | 'exact'): 'presence_in_context' | 'live_session_sharing' {
  return precision === 'exact' ? 'live_session_sharing' : 'presence_in_context';
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return h === 1 ? '1 hour' : `${h} hours`;
}
