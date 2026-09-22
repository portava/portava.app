/**
 * SuggestionOverlay — the container surface for suggestions under a field
 * (spec §27 UI surfaces, §37 empty/no-match, §46 accessibility, §33 stable
 * layout under the keyboard).
 *
 * Responsibilities:
 *  - render grouped sections (or a flat list) in an internally-scrolling card,
 *    capped in height and VIRTUALIZED, so neither the row count nor the
 *    available screen space can make it grow unbounded;
 *  - keep taps working while the software keyboard is up
 *    (keyboardShouldPersistTaps="handled") — the "no overlay trapped behind the
 *    keyboard" guarantee (§46) is met by keeping this INLINE below the field
 *    rather than in a modal, AND by the height budget below, which measures the
 *    obstruction instead of arguing about it;
 *  - announce loading + result count to screen readers via a polite live region
 *    (§46 "announce suggestion count");
 *  - present the §27 ZERO-STATE PANEL before typing, a context-dependent
 *    empty / no-match state (§37) and a quiet "assistance unavailable" degraded
 *    note (§38) — never an error that collapses the input.
 *
 * ── THE DEGRADED STATE IS ITS OWN STATE (§27, §32, §37; census G13) ──────────
 *
 * §27 requires every surface to support "loading states, error states, empty
 * states", and §37's own heading names TWO states — empty AND no-match. This
 * container used to have ONE shape for the degraded case: the same
 * caller-supplied `emptyState` slot that holds §37's context-dependent fallback
 * actions ("Drop a pin", "Add a new Place"). So a field whose authority could
 * not be REACHED told the user that a search had found nothing and offered to
 * create a record instead, and a field the authority declines to assist offline
 * at all (`server_required`) showed a panel with nothing in it and no sentence.
 *
 * `degradedNotice.ts` decides which of the three degraded sentences applies;
 * this file renders it, ABOVE the rows when there are rows and INSTEAD of the
 * no-match state when there are none. `emptyState` can no longer mask it —
 * that slot is for a search that happened.
 *
 * It renders no row, and it cannot: the rows it draws are the ones the hook
 * handed it, and the hook's §32 gate (`useInputAssistance.ts#mayRetain`) is
 * what decides whether a degraded field has any. This surface explains an
 * absence; it never fills one.
 *
 * This component is presentational: it does not fetch. `SmartInput` (or any
 * consumer) feeds it the hook output.
 */
import React, { useContext, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Keyboard,
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { groupSuggestions, SuggestionSectionHeader, type SuggestionSection } from './SuggestionGroup.tsx';
import { SuggestionRow } from './SuggestionList.tsx';
import { ZeroStatePanel } from './ZeroStatePanel.tsx';
import { degradedNotice } from './degradedNotice.ts';
import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';

/**
 * §33 "stable layout under the mobile keyboard" / §27 "safe-area behaviour".
 *
 * The card must never be taller than the space that is actually free. Two
 * obstructions can eat the bottom of the screen and only one of them is ever
 * present at a time: the software keyboard (which also covers the home
 * indicator), or, when it is down, the bottom safe-area inset. `reserved` is
 * therefore a max, not a sum — adding them would shrink the card by a gesture
 * bar that is currently behind a keyboard.
 *
 * Pure, exported and unit-tested, because the alternative is asserting the
 * guarantee in a comment. That is exactly what this overlay used to do: it
 * claimed the keyboard guarantee followed from being inline, with no inset read
 * and no keyboard listener anywhere in the layer.
 */
export const OVERLAY_MIN_HEIGHT = 96;
/** Space kept between the card's bottom edge and whatever is under it. */
export const OVERLAY_GUTTER = 24;

export function overlayHeightBudget(params: {
  requestedMaxHeight: number;
  windowHeight: number;
  keyboardHeight: number;
  bottomInset: number;
}): number {
  const { requestedMaxHeight, windowHeight, keyboardHeight, bottomInset } = params;
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return requestedMaxHeight;
  const reserved = keyboardHeight > 0 ? keyboardHeight : Math.max(0, bottomInset);
  const available = windowHeight - reserved - OVERLAY_GUTTER;
  // Never below the floor: a card squeezed to nothing is a worse failure than a
  // card that overlaps, because it removes the escape route (§38 "must not
  // collapse the input UI").
  return Math.max(OVERLAY_MIN_HEIGHT, Math.min(requestedMaxHeight, available));
}

/** Current software-keyboard height, 0 when it is down. */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e: any) => {
      const h = e?.endCoordinates?.height;
      setHeight(typeof h === 'number' && h > 0 ? h : 0);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

type OverlayRow =
  | { key: string; kind: 'header'; label: string }
  | { key: string; kind: 'row'; suggestion: InputSuggestion };

/** Flatten sections into one virtualizable stream of rows. */
export function flattenSections(sections: SuggestionSection[]): OverlayRow[] {
  const out: OverlayRow[] = [];
  sections.forEach((section, i) => {
    if (section.suggestions.length === 0) return;
    if (section.label) out.push({ key: `h:${section.label}:${i}`, kind: 'header', label: section.label });
    for (const s of section.suggestions) out.push({ key: `s:${s.id}`, kind: 'row', suggestion: s });
  });
  return out;
}

export interface SuggestionOverlayProps {
  visible: boolean;
  loading: boolean;
  /** Endpoint unavailable / offline — show a quiet degraded note, no error. */
  unavailable?: boolean;
  /**
   * §32 — whether the field's `offlinePolicy` licenses ANY offline surface,
   * i.e. `offlineSurfaceAllowed(policy.offlinePolicy)`. It selects which
   * degraded sentence is honest; it does NOT decide what renders, because the
   * rows are already gone by the time they reach this component.
   *
   * Defaults to `false`, which is the same fail-closed answer
   * `offlineSurfaceAllowed(null)` gives: an undeclared caller gets the
   * online-only sentence rather than a claim about a device cache this
   * component cannot see. With rows on screen the notice ignores it and
   * describes the rows (see `degradedNotice.ts`), so the default can never
   * contradict what is visible.
   */
  offlineSurface?: boolean;
  /** Flat suggestions (auto-grouped) — ignored when `sections` is provided. */
  suggestions?: InputSuggestion[];
  /** Pre-built sections (overrides `suggestions`). */
  sections?: SuggestionSection[];
  onSelect: (s: InputSuggestion) => void;
  activeId?: string | null;
  renderLeading?: (s: InputSuggestion) => React.ReactNode;
  /** Whether to render section headers when auto-grouping flat suggestions. */
  grouped?: boolean;
  /** Context-dependent fallback actions for the no-match state (§37). */
  emptyState?: React.ReactNode;
  /**
   * §27 — the field is EMPTY, so whatever rows are present are the "before
   * typing" set and belong in the zero-state panel, not in a results list.
   */
  zeroState?: boolean;
  /** Heading for the zero-state panel (e.g. "Recent", "Nearby"). */
  zeroStateTitle?: string;
  /** Pre-typing hint shown when the zero-state set is empty. */
  zeroStateHint?: string;
  /** Cap on the overlay height. The real cap is the min of this and the budget. */
  maxHeight?: number;
  testID?: string;
}

export function SuggestionOverlay({
  visible,
  loading,
  unavailable,
  offlineSurface = false,
  suggestions,
  sections,
  onSelect,
  activeId,
  renderLeading,
  grouped = true,
  emptyState,
  zeroState,
  zeroStateTitle,
  zeroStateHint,
  maxHeight = 320,
  testID,
}: SuggestionOverlayProps) {
  // Hooks run before the early return — a conditional hook would break the
  // order on the render where the overlay hides.
  const keyboardHeight = useKeyboardHeight();
  // CONTEXT, not `useSafeAreaInsets()`: that hook THROWS when no
  // SafeAreaProvider is above it, and this overlay is mounted by whatever screen
  // owns the field. An input that cannot render because a provider is missing
  // would be a worse regression than an un-inset card, and §38 forbids the
  // assistance layer collapsing the input UI. `null` ⇒ inset 0.
  const insets = useContext(SafeAreaInsetsContext);
  const { height: windowHeight } = useWindowDimensions();

  const flat = suggestions ?? [];
  const resolvedSections: SuggestionSection[] = useMemo(
    () => sections ?? (grouped ? groupSuggestions(flat) : [{ label: '', suggestions: flat }]),
    // `flat` is a fresh array each render when `suggestions` is; addressing it
    // through `suggestions` keeps the memo keyed on the caller's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, grouped, suggestions],
  );
  const rows = useMemo(() => flattenSections(resolvedSections), [resolvedSections]);
  const total = rows.reduce((n, r) => n + (r.kind === 'row' ? 1 : 0), 0);

  const budget = overlayHeightBudget({
    requestedMaxHeight: maxHeight,
    windowHeight,
    keyboardHeight,
    bottomInset: insets?.bottom ?? 0,
  });

  if (!visible) return null;

  // §32 — which degraded sentence, if any. Computed after the early return so
  // a hidden overlay decides nothing.
  const degraded = degradedNotice({
    unavailable: unavailable === true,
    offlineSurface,
    rowCount: total,
  });

  // §46 — the polite live region. THE DEGRADED ANNOUNCEMENT COMES BEFORE THE
  // COUNT, deliberately: a sighted user sees the note above the rows, and the
  // old order meant a screen-reader user heard "3 suggestions" for a degraded
  // list and never learned it was device-local (G13). Loading still wins, since
  // "we are asking" is the only one of the three that is about to change.
  const status = loading
    ? 'Loading suggestions'
    : degraded
      ? total > 0
        ? `${degraded.a11y} ${total} suggestion${total === 1 ? '' : 's'}.`
        : degraded.a11y
      : total > 0
        ? `${total} suggestion${total === 1 ? '' : 's'}`
        : zeroState
          ? 'No suggestions yet'
          : 'No suggestions';

  // §33 "virtualize large suggestion groups". This used to be a ScrollView,
  // which mounts every row in the group no matter how many there are. The cap
  // (§33's other half) is enforced server-side and again in the client ranker,
  // so today the list is short — but the cap is a POLICY value and the
  // mechanism has to hold when a context raises it. A FlatList mounts a window.
  const list = (
    <FlatList
      testID="ia-suggestion-scroll"
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <SuggestionSectionHeader label={item.label} />
        ) : (
          <SuggestionRow
            suggestion={item.suggestion}
            onSelect={onSelect}
            activeId={activeId}
            renderLeading={renderLeading}
          />
        )
      }
      // A VirtualizedList memoizes its mounted cells, and `rows` is stable
      // while the suggestion list is — so a cell would not re-render for a
      // changed `activeId` on `data` identity alone. NOT CURRENTLY PROVEN:
      // removing this line leaves the keyboard-navigation suite green, because
      // `renderItem` below is an inline arrow whose identity changes every
      // render and busts the memo by accident. It is kept because that accident
      // is exactly what a future `useCallback` around `renderItem` would
      // remove, silently freezing the highlight — and `extraData` is the
      // documented way to say what a cell depends on.
      extraData={activeId}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator
      initialNumToRender={8}
      windowSize={3}
      maxToRenderPerBatch={8}
      style={styles.scroll}
      contentContainerStyle={[
        styles.scrollContent,
        // §27 safe-area behaviour: when the keyboard is DOWN the card can sit
        // over the home indicator, so the last row gets the inset as padding
        // and stays tappable. With the keyboard up the inset is behind it.
        { paddingBottom: space.xs + (keyboardHeight > 0 ? 0 : Math.max(0, insets?.bottom ?? 0)) },
      ]}
    />
  );

  return (
    <View style={[styles.card, { maxHeight: budget }]} testID={testID ?? 'ia-suggestion-overlay'}>
      {/* Polite live region — announces count / loading to screen readers (§46). */}
      <Text
        style={styles.srStatus}
        accessibilityLiveRegion="polite"
        accessibilityRole="text"
        // Visually minimal but present; not hidden from a11y tree.
      >
        {status}
      </Text>

      {loading && total === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={color.deep} />
          <Text style={styles.loadingText}>Finding suggestions…</Text>
        </View>
      ) : null}

      {/* §32 DEGRADED NOTE. Above the rows when there are rows — it is about
          them (they are device-local and were not re-checked) — and on its own
          when there are none. It is NOT inside the `emptyState ?? …` fallback
          any more: a caller's §37 fallback actions answer "nothing matched",
          which is not what happened here. */}
      {degraded && !loading ? (
        <View style={styles.degraded} testID={`ia-degraded-${degraded.kind}`}>
          <Text style={styles.degradedTitle} accessibilityRole="header" numberOfLines={1}>
            {degraded.title}
          </Text>
          <Text style={styles.degradedDetail}>{degraded.detail}</Text>
        </View>
      ) : null}

      {/* §27 zero-state panel — before typing, the rows are framed as the
          pre-typing set rather than as results, and their absence is a
          different sentence from "no matches". */}
      {zeroState && !loading && !unavailable ? (
        <ZeroStatePanel title={zeroStateTitle} hint={zeroStateHint} count={total} body={list} />
      ) : total > 0 ? (
        list
      ) : !loading && !degraded ? (
        <View style={styles.empty}>
          {emptyState ?? <Text style={styles.emptyText}>No matches yet.</Text>}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    overflow: 'hidden',
    ...shadow.card,
  },
  srStatus: {
    // Kept in the a11y tree but visually unobtrusive.
    height: 0,
    opacity: 0,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingTop: space.xs,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  loadingText: {
    ...t.small,
    color: color.mute,
  },
  empty: {
    paddingHorizontal: space.md,
    paddingVertical: space.lg,
    alignItems: 'flex-start',
  },
  // §38 "provider failure must not collapse the input UI": a quiet note in the
  // card's own colours, not an error banner. No red, no icon, no button — there
  // is nothing for the user to press and nothing for this layer to retry.
  degraded: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    alignItems: 'flex-start',
  },
  degradedTitle: {
    ...t.stamp,
    color: color.faint,
    paddingBottom: space.xs,
  },
  degradedDetail: {
    ...t.small,
    color: color.mute,
  },
  emptyText: {
    ...t.small,
    color: color.mute,
  },
});
