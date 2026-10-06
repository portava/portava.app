/**
 * HighlightActionChips — §12's executable verbs in the Highlight viewer
 * (census-highlights-memories H102): Do this, Add to trip, View place, Save.
 *
 * ASK is the viewer's existing reply button and is not repeated here; MEET is
 * refused by the server by name. The venue verbs run on the Memory this
 * Highlight projects, and only when the server says this viewer may read it:
 *
 *   Do this / Add to trip   close the viewer, open that Memory, and start the
 *                           action there (MemoryActionBar `autoAction`) — where
 *                           the plan is compiled against the world now
 *   View place              close the viewer, open the CURRENT catalog place
 *   Save                    save that Memory (the existing save route)
 *
 * HONEST STATES. A failed read shows a one-line "could not check" with Try
 * again, never nothing — and that includes a menu that ARRIVED but whose venue
 * verbs were refused because something behind them could not be read (the
 * source link, the Memory, the place, or its privacy): those are
 * could-not-check, not "nothing to do" (verifier finding 4). A Highlight with
 * nothing to do shows nothing, because that IS the answer (a sourceless
 * Highlight has no place to act on).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Repeat, ListPlus, MapPin, Bookmark } from 'lucide-react-native';
import { closeThenNavigate } from '../../../lib/deferredNavigate.ts';
import { saveMemory } from '../../../services/memorySocial.ts';
import { getHighlightActions, type HighlightActionMenu, type HighlightActionName } from './highlightActionsApi.ts';

type State = { s: 'loading' } | { s: 'error'; message: string } | { s: 'ok'; menu: HighlightActionMenu };

const SHOWN: readonly HighlightActionName[] = ['DO_THIS', 'ADD_TO_TRIP', 'VIEW_PLACE', 'SAVE'];
const LABEL: Record<string, string> = { DO_THIS: 'Do this', ADD_TO_TRIP: 'Add to trip', VIEW_PLACE: 'View place', SAVE: 'Save' };
/** Refusals that mean "could not check", not "no": each is said, with Try again. */
export const UNCHECKED_REASONS: ReadonlySet<string> = new Set([
  'SOURCE_UNREADABLE', 'SOURCE_STORE_UNAVAILABLE', 'PLACE_UNREADABLE', 'PRIVACY_UNREADABLE',
]);
const ICON: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  DO_THIS: Repeat, ADD_TO_TRIP: ListPlus, VIEW_PLACE: MapPin, SAVE: Bookmark,
};

export function HighlightActionChips({ highlightId, onClose }: { highlightId: string; onClose: () => void }) {
  const [state, setState] = useState<State>({ s: 'loading' });
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const load = useCallback(async () => {
    setState({ s: 'loading' });
    setSaved('idle');
    const r = await getHighlightActions(highlightId);
    if (r.ok) setState({ s: 'ok', menu: r.menu });
    // not_found: the viewer's own gate will say so; nothing to offer here.
    else setState(r.kind === 'not_found' ? { s: 'ok', menu: { highlightId, sourceMemoryId: null, place: null, actions: [] } } : { s: 'error', message: r.message });
  }, [highlightId]);

  useEffect(() => { void load(); }, [load]);

  if (state.s === 'loading') return null;
  const retryRow = (testID: string) => (
    <View style={s.row} testID={testID}>
      <Text style={s.note}>Could not check what you can do with this.</Text>
      <Pressable onPress={load} testID="highlight-actions-retry" accessibilityRole="button" accessibilityLabel="Try again">
        <Text style={s.link}>Try again</Text>
      </Pressable>
    </View>
  );
  if (state.s === 'error') {
    return (
      <View style={s.row} testID="highlight-actions-error">
        <Text style={s.note}>Could not check what you can do with this.</Text>
        <Pressable onPress={load} testID="highlight-actions-retry" accessibilityRole="button" accessibilityLabel="Try again">
          <Text style={s.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const { menu } = state;
  const offered = SHOWN.filter((a) => menu.actions.some((d) => d.action === a && d.available));
  const unchecked = SHOWN.some((a) => menu.actions.some((d) => d.action === a && !d.available && d.reason != null && UNCHECKED_REASONS.has(d.reason)));
  if (offered.length === 0) return unchecked ? retryRow('highlight-actions-error') : null;

  const run = async (a: HighlightActionName) => {
    const memoryId = menu.sourceMemoryId;
    if (a === 'VIEW_PLACE') { if (menu.place) closeThenNavigate(onClose, `/place/${menu.place.id}`); return; }
    if (!memoryId) return;
    if (a === 'DO_THIS') { closeThenNavigate(onClose, { pathname: '/memory/[id]', params: { id: memoryId, action: 'DO_AGAIN' } }); return; }
    if (a === 'ADD_TO_TRIP') { closeThenNavigate(onClose, { pathname: '/memory/[id]', params: { id: memoryId, action: 'ADD_TO_TRIP' } }); return; }
    if (a === 'SAVE') {
      setSaved('saving');
      const r = await saveMemory(memoryId);
      setSaved(r.ok && r.savedByMe ? 'saved' : 'failed');
    }
  };

  return (
    <View style={s.row} testID="highlight-actions">
      {offered.map((a) => {
        const Icon = ICON[a]!;
        const isSave = a === 'SAVE';
        return (
          <Pressable
            key={a}
            style={s.chip}
            onPress={() => { void run(a); }}
            disabled={isSave && (saved === 'saving' || saved === 'saved')}
            testID={`highlight-action-${a}`}
            accessibilityRole="button"
            accessibilityLabel={LABEL[a]}
          >
            {isSave && saved === 'saving' ? <ActivityIndicator size="small" color="#fff" /> : <Icon size={14} color="#fff" />}
            <Text style={s.chipText}>{isSave && saved === 'saved' ? 'Saved' : LABEL[a]}</Text>
          </Pressable>
        );
      })}
      {saved === 'failed' ? <Text style={s.note} testID="highlight-save-failed">Could not save. Try again.</Text> : null}
      {unchecked ? retryRow('highlight-actions-unchecked') : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(17,17,15,0.35)',
  },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  note: { color: 'rgba(250,249,246,0.85)', fontSize: 12 },
  link: { color: '#fff', fontSize: 12, fontWeight: '700', textDecorationLine: 'underline' },
});
