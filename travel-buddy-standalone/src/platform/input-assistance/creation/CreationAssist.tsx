/**
 * CreationAssist — the inline, NON-BLOCKING creation overlay (spec §20, §23, §55).
 *
 * One drop-in surface a creation screen renders under its name/title (or location)
 * field. It shows, when the P1 gateway provides them:
 *   1. a §23 validation/correction notice — via the shared P1 `CorrectionBanner`
 *      (duplicate warning, city-country mismatch, date conflict, unresolved
 *      address, invalid hashtag/handle); and
 *   2. a §20/§55 "did you mean this existing …?" duplicate notice — existing Gem /
 *      Place / Event candidates rendered through the shared P1 `EntitySuggestionRow`,
 *      with the shared P1 `DisambiguationSheet` as the "see all matches" surface.
 *
 * NON-BLOCKING BY CONTRACT (§2): everything here is advisory and dismissible. The
 * user may always keep creating — nothing gates the screen's submit. When the
 * gateway returns neither validation nor duplicates (or is unavailable), this
 * renders `null` and the creation flow behaves exactly as before (§38 degrade).
 *
 * The component reuses P1 primitives; it does NOT fork them.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Copy } from 'lucide-react-native';
import { color, space, radius, type as t, icon as iconToken } from '../../../theme/tokens.ts';
import { CorrectionBanner } from '../components/CorrectionBanner.tsx';
import { EntitySuggestionRow } from '../components/EntitySuggestionRow.tsx';
import { DisambiguationSheet } from '../components/DisambiguationSheet.tsx';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { DuplicateCandidate } from './duplicateDetection.ts';
import type { CreationValidationView } from './creationValidation.ts';

export interface CreationAssistProps {
  /** Existing-entity candidates surfaced for the current name/title (§20/§55). */
  duplicates: DuplicateCandidate[];
  /** The single §23 validation/correction to surface, or null. */
  validation: CreationValidationView | null;
  /** Noun for the duplicate header. Auto-derived from the top candidate if omitted. */
  entityNoun?: string;
  /** User confirms an existing entity instead of creating a new one (§55). Non-blocking. */
  onPickExisting?: (candidate: DuplicateCandidate) => void;
  /** User accepts a §23 canonical correction (only offered when one exists). */
  onAcceptCorrection?: (validation: CreationValidationView) => void;
  testID?: string;
}

/** How many candidates to show inline before offering the "see all" sheet. */
const INLINE_CAP = 2;

const NOUN_BY_KIND: Record<DuplicateCandidate['entityType'], string> = {
  hidden_gem: 'Gem',
  place: 'Place',
  event: 'Event',
};

function dupKeyOf(duplicates: DuplicateCandidate[]): string {
  return duplicates.map((d) => `${d.entityType}:${d.entityId}`).join('|');
}

function valKeyOf(validation: CreationValidationView | null): string | null {
  return validation ? `${validation.kind}:${validation.message}` : null;
}

function CreationAssistBase({
  duplicates,
  validation,
  entityNoun,
  onPickExisting,
  onAcceptCorrection,
  testID,
}: CreationAssistProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dismissedDupKey, setDismissedDupKey] = useState<string | null>(null);
  const [dismissedValKey, setDismissedValKey] = useState<string | null>(null);

  const dupKey = dupKeyOf(duplicates);
  const valKey = valKeyOf(validation);

  // A dismissal only silences the CURRENT content — new candidates / a new
  // validation message re-surface the notice (the keys change).
  useEffect(() => {
    if (duplicates.length === 0 && sheetOpen) setSheetOpen(false);
  }, [duplicates.length, sheetOpen]);

  const dupVisible = duplicates.length > 0 && dismissedDupKey !== dupKey;
  const valVisible = validation != null && dismissedValKey !== valKey;

  if (!dupVisible && !valVisible) return null;

  const noun = entityNoun ?? (duplicates[0] ? NOUN_BY_KIND[duplicates[0].entityType] : 'entry');
  const inline = duplicates.slice(0, INLINE_CAP);
  const hasMore = duplicates.length > INLINE_CAP;

  const pickFromSheet = (s: InputSuggestion) => {
    const cand = duplicates.find((d) => d.suggestion.id === s.id) ?? null;
    // Close the sheet first, then act — never navigate in the same tick as the
    // Modal close (the close-then-navigate race). The screen owns onPickExisting.
    setSheetOpen(false);
    if (cand && onPickExisting) setTimeout(() => onPickExisting(cand), 0);
  };

  return (
    <View style={styles.wrap} testID={testID ?? 'creation-assist'}>
      {valVisible && validation ? (
        <CorrectionBanner
          message={validation.message}
          tone={validation.tone}
          acceptLabel={validation.acceptLabel ?? undefined}
          onAccept={
            validation.acceptLabel && onAcceptCorrection
              ? () => onAcceptCorrection(validation)
              : undefined
          }
          onDismiss={() => setDismissedValKey(valKey)}
          testID="creation-validation-banner"
        />
      ) : null}

      {dupVisible ? (
        <View style={styles.dupCard} accessibilityRole="summary" testID="creation-duplicate-notice">
          <View style={styles.dupHeader}>
            <Copy size={iconToken.s16} color={color.deep} />
            <Text style={styles.dupHeaderText} numberOfLines={2}>
              {`Did you mean an existing ${noun}?`}
            </Text>
          </View>

          <View style={styles.dupList}>
            {inline.map((d) => (
              <EntitySuggestionRow
                key={`${d.entityType}:${d.entityId}`}
                suggestion={d.suggestion}
                onPress={() => onPickExisting?.(d)}
                testID={`creation-duplicate-${d.entityId}`}
              />
            ))}
          </View>

          <View style={styles.dupActions}>
            {hasMore ? (
              <Pressable
                onPress={() => setSheetOpen(true)}
                style={styles.dupAction}
                accessibilityRole="button"
                accessibilityLabel={`See all ${duplicates.length} matches`}
              >
                <Text style={styles.dupActionText}>{`See all ${duplicates.length}`}</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <Pressable
              onPress={() => setDismissedDupKey(dupKey)}
              style={styles.dupAction}
              accessibilityRole="button"
              accessibilityLabel="Not a duplicate, keep creating"
              hitSlop={6}
            >
              <Text style={styles.dupDismissText}>Keep creating</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <DisambiguationSheet
        visible={sheetOpen}
        query={duplicates[0]?.label ?? ''}
        candidates={duplicates.map((d) => d.suggestion)}
        onSelect={pickFromSheet}
        onSearchInstead={() => {
          setSheetOpen(false);
          setDismissedDupKey(dupKey);
        }}
        onClose={() => setSheetOpen(false)}
        title={`Existing ${noun}s`}
      />
    </View>
  );
}

export const CreationAssist = React.memo(CreationAssistBase);

const styles = StyleSheet.create({
  wrap: {
    gap: space.sm,
    marginTop: space.sm,
  },
  dupCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    borderRadius: radius.md,
    backgroundColor: color.paperRaised,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
  },
  dupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingBottom: space.xs,
  },
  dupHeaderText: {
    ...t.small,
    color: color.deep,
    fontWeight: '700',
    flex: 1,
    minWidth: 0,
  },
  dupList: {},
  dupActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
    paddingTop: space.xs,
  },
  dupAction: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  dupActionText: {
    ...t.small,
    color: color.deep,
    fontWeight: '700',
  },
  dupDismissText: {
    ...t.small,
    color: color.mute,
  },
});
