/**
 * Telegraph §14.3 — "Add people" on a direct conversation (census T212, T213, T390, T201).
 *
 * Adding a third person to a DM does NOT add them to the DM. It creates a NEW group of the two of you
 * and the people you pick, and the new group starts empty: nothing from the DM is copied, and the
 * people you add can never read it. The sheet says so before anything is sent.
 *
 * Plans and places you share in this conversation may be brought along as NEW share cards — only the
 * ones you tick, and only if everyone in the new group can see them (the server checks each one and
 * refuses the whole group in one sentence if it cannot).
 *
 * The sheet is offered only when the server says `canInvite` (conversationProjection.offersAddPeople).
 * It decides nothing itself: a refusal is the server's sentence, shown as it came, and nothing on screen
 * changes until the server answers that the group exists.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { radius, space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { useTelegraphRecipients } from '../../../hooks/useTelegraphRecipients.ts'; import type { RecipientRow } from '../../../platform/input-assistance/social/telegraphRecipients.ts'; // G359: people search goes through the input-assistance gateway, never an engine of its own
import { fetchSharedContext } from '../sharedContext/api.ts';
import type { SharedContextItem } from '../sharedContext/types.ts';
import {
  MAX_ADDED_PEOPLE,
  MAX_CARRY_FORWARD,
  MAX_GROUP_TITLE,
  addPeopleToConversation,
  type CarryForwardKind,
  type CarryForwardSelection,
} from './addPeopleApi.ts';

export interface AddPeopleSheetProps {
  visible: boolean;
  threadId: string | null;
  /** The other person in this DM, for the copy only. */
  partnerName?: string | null;
  onClose: () => void;
  /** Told the NEW group's id once the server has created it. */
  onCreated: (groupThreadId: string) => void;
}

export const ADD_PEOPLE_NEW_GROUP_COPY =
  'This starts a new group. Your conversation here stays private: nothing from it is copied, and the people you add cannot read it.';

interface Picked {
  id: string;
  label: string;
}

/** Which shared items may be brought along: plans (meetups) and places, never anything past. */
export function carryForwardCandidates(items: readonly SharedContextItem[]): Array<{ kind: CarryForwardKind; objectId: string; title: string }> {
  const out: Array<{ kind: CarryForwardKind; objectId: string; title: string }> = [];
  const seen = new Set<string>();
  for (const it of items) {
    const kind: CarryForwardKind | null = it.objectType === 'PLACE' ? 'PLACE' : it.objectType === 'PLAN' || it.objectType === 'MEETUP' ? 'PLAN' : null;
    if (!kind || !it.objectId) continue;
    const key = `${kind}:${it.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, objectId: it.objectId, title: it.title });
  }
  return out;
}

function labelFor(u: RecipientRow): string {
  return u.name || (u.handle ? `@${u.handle}` : 'Traveller');
}

export function AddPeopleSheet({ visible, threadId, partnerName, onClose, onCreated }: AddPeopleSheetProps) {
  const { palette, styles } = useTelegraphTheme(makeStyles);
  const [query, setQuery] = useState('');
  // The people search is the P1 gateway's `telegraph_recipient` context (useInputAssistance via
  // useTelegraphRecipients): the server applies blocks, privacy and enumeration protection before any
  // row reaches here, and this sheet re-filters nothing. Asked only from two characters and while open.
  const q = query.trim();
  const { recipients: results, loading: searching, unavailable, recordPick } = useTelegraphRecipients(q.length >= 2 ? q : '', { surface: 'telegraph_add_people', enabled: visible && q.length >= 2 });
  const searchError = unavailable ? 'We could not search right now. Please try again.' : null;
  const [picked, setPicked] = useState<Picked[]>([]);
  const [candidates, setCandidates] = useState<Array<{ kind: CarryForwardKind; objectId: string; title: string }>>([]);
  const [carry, setCarry] = useState<CarryForwardSelection[]>([]);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh sheet every time it opens: no selection survives a close.
  useEffect(() => {
    if (!visible) return;
    setQuery(''); setPicked([]); setCarry([]); setTitle(''); setError(null);
    let live = true;
    if (threadId) {
      void fetchSharedContext(threadId).then((r) => {
        if (!live || !r.ok) return; // an unreadable rail offers nothing to bring along; it never guesses
        const p = r.data.sharedContext;
        setCandidates(carryForwardCandidates([...p.now, ...p.upcoming, ...p.unresolved]).slice(0, MAX_CARRY_FORWARD));
      });
    }
    return () => { live = false; };
  }, [visible, threadId]);

  const pickedIds = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);

  const toggle = useCallback((u: RecipientRow) => {
    const adding = !picked.some((p) => p.id === u.userId) && picked.length < MAX_ADDED_PEOPLE;
    setPicked((cur) => {
      if (cur.some((p) => p.id === u.userId)) return cur.filter((p) => p.id !== u.userId);
      if (cur.length >= MAX_ADDED_PEOPLE) return cur;
      return [...cur, { id: u.userId, label: labelFor(u) }];
    });
    if (adding) recordPick(u); // §35 selection memory: fire-and-forget, never gates the pick
  }, [picked, recordPick]);

  const toggleCarry = useCallback((c: CarryForwardSelection) => {
    setCarry((cur) => (cur.some((x) => x.kind === c.kind && x.objectId === c.objectId)
      ? cur.filter((x) => !(x.kind === c.kind && x.objectId === c.objectId))
      : [...cur, c]));
  }, []);

  const create = async () => {
    if (!threadId || submitting || picked.length === 0) return;
    setSubmitting(true);
    setError(null);
    const r = await addPeopleToConversation(threadId, { userIds: picked.map((p) => p.id), carryForward: carry, title });
    setSubmitting(false);
    if (r.ok) onCreated(r.data.threadId);
    else setError(r.message);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close add people" />
      <View style={styles.sheet} testID="add-people-sheet">
        <Text style={styles.title} accessibilityRole="header">Add people</Text>
        <Text style={styles.note} testID="add-people-new-group-copy">
          {partnerName ? `${ADD_PEOPLE_NEW_GROUP_COPY.replace('Your conversation here', `Your conversation with ${partnerName}`)}` : ADD_PEOPLE_NEW_GROUP_COPY}
        </Text>
        <TextInput
          testID="add-people-search"
          style={styles.input}
          placeholder="Search people"
          placeholderTextColor={palette.mute}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search people to add"
        />
        <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
          {searching ? <ActivityIndicator testID="add-people-searching" color={palette.operational} /> : null}
          {searchError ? <Text style={styles.error} testID="add-people-search-error">{searchError}</Text> : null}
          {results.map((u) => {
            const selected = pickedIds.has(u.userId);
            return (
              <Pressable
                key={u.userId}
                testID={`add-people-result-${u.userId}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
                onPress={() => toggle(u)}
                style={styles.row}
              >
                <Text style={styles.rowLabel}>{labelFor(u)}{selected ? ' ✓' : ''}</Text>
                {u.handle ? <Text style={styles.rowSub}>@{u.handle}</Text> : null}
              </Pressable>
            );
          })}
          {candidates.length > 0 ? (
            <View testID="add-people-carry">
              <Text style={styles.section}>Bring along (optional)</Text>
              {candidates.map((c) => {
                const on = carry.some((x) => x.kind === c.kind && x.objectId === c.objectId);
                return (
                  <Pressable
                    key={`${c.kind}:${c.objectId}`}
                    testID={`add-people-carry-${c.kind}-${c.objectId}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    onPress={() => toggleCarry({ kind: c.kind, objectId: c.objectId })}
                    style={styles.row}
                  >
                    <Text style={styles.rowLabel}>{c.title}{on ? ' ✓' : ''}</Text>
                    <Text style={styles.rowSub}>{c.kind === 'PLAN' ? 'Plan' : 'Place'} — shared as a new card</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </ScrollView>
        {picked.length > 0 ? (
          <Text style={styles.rowSub} testID="add-people-picked">Adding {picked.map((p) => p.label).join(', ')}</Text>
        ) : null}
        <TextInput
          testID="add-people-title"
          style={styles.input}
          placeholder="Group name (optional)"
          placeholderTextColor={palette.mute}
          value={title}
          maxLength={MAX_GROUP_TITLE}
          onChangeText={setTitle}
          accessibilityLabel="Group name"
        />
        {error ? <Text style={styles.error} testID="add-people-error">{error}</Text> : null}
        <Pressable
          testID="add-people-create"
          accessibilityRole="button"
          accessibilityState={{ disabled: picked.length === 0 || submitting }}
          disabled={picked.length === 0 || submitting}
          onPress={() => { void create(); }}
          style={[styles.create, (picked.length === 0 || submitting) && styles.createDisabled]}
        >
          <Text style={styles.createLabel}>{submitting ? 'Creating…' : 'Create group'}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({ // census T123/T124: the scheme's palette; the create action is ordinary emphasis (teal)
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: p.surface, padding: space.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, gap: space.sm, maxHeight: '85%' },
  title: { ...t.bodyStrong, color: p.recvText },
  note: { ...t.small, color: p.mute },
  input: { ...t.body, color: p.recvText, borderWidth: 1, borderColor: p.haze, borderRadius: radius.md, paddingHorizontal: space.sm, minHeight: 44 },
  results: { maxHeight: 280 },
  section: { ...t.small, color: p.mute, marginTop: space.sm, fontWeight: '600' },
  row: { paddingVertical: space.sm, minHeight: 44 },
  rowLabel: { ...t.body, color: p.recvText },
  rowSub: { ...t.small, color: p.mute },
  error: { ...t.small, color: p.recvText, fontWeight: '600' },
  create: { backgroundColor: p.operational, borderRadius: radius.md, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  createDisabled: { opacity: 0.5 },
  createLabel: { ...t.bodyStrong, color: p.operationalOn },
});

export default AddPeopleSheet;
