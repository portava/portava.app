/**
 * TripSharedContentSection — the trip's shared contents on screen (TRIP-F24, WP-10).
 *
 * Five tabs over the 0079 sub-tables' routes: Notes, Documents, Checklists,
 * Reminders and (for the owner and co-hosts) Activity. Each tab reads on
 * first open and draws its own three states — loading, a failed read with a
 * retry (never an empty list), and a true empty state — and writes only
 * through its route. What the viewer sees of private notes and documents is
 * the server's §6.3 rule, not a filter here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useLatestRead } from '../shared/latestRead.ts';
import { View, Text, ActivityIndicator, StyleSheet, Pressable, TextInput, Switch, Alert } from 'react-native';
import { StickyNote, FileText, ListChecks, Bell, Activity, CloudOff, Plus, Square, SquareCheck, Trash2, Lock } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { writeFailureText, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';
import * as api from './tripSharedContent.ts';

type Tab = 'notes' | 'documents' | 'checklists' | 'reminders' | 'activity';
const TAB_LABEL: Record<Tab, string> = { notes: 'Notes', documents: 'Documents', checklists: 'Checklists', reminders: 'Reminders', activity: 'Activity' };
const TAB_ICON: Record<Tab, typeof StickyNote> = { notes: StickyNote, documents: FileText, checklists: ListChecks, reminders: Bell, activity: Activity };

interface Props {
  tripId: string;
  /** Owner or co-host: the activity feed is theirs (canHostTrip). */
  isHost: boolean;
  /** Test seam: the whole client module. */
  client?: typeof api;
}

/** Read once, keep the three states apart, retry on demand; the latest read wins (§79). */
function useRead<T>(fn: () => Promise<ApiRead<T>>) {
  const [read, setRead] = useState<ApiRead<T> | undefined>(undefined);
  const begin = useLatestRead();
  const run = useCallback(async () => {
    const current = begin();
    setRead(undefined);
    try { const r = await fn(); if (current()) setRead(r); }
    catch (e: any) { if (current()) setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [fn, begin]);
  useEffect(() => { void run(); }, [run]);
  return { read, run, setRead };
}

function Loading({ id }: { id: string }) {
  return <ActivityIndicator size="small" color={color.signal} style={{ margin: space.md }} testID={id} />;
}
function Failed({ id, what, detail, onRetry }: { id: string; what: string; detail: string; onRetry: () => void }) {
  return (
    <View style={s.stateRow} testID={id}>
      <CloudOff size={13} color={color.mute} />
      <View style={{ flex: 1 }}>
        <Text style={s.detail}>Couldn&apos;t load {what} ({detail}). This is not an empty list.</Text>
        <Pressable onPress={onRetry} style={s.smallBtn} accessibilityRole="button" testID={`${id}-retry`}><Text style={s.smallBtnText}>Try again</Text></Pressable>
      </View>
    </View>
  );
}
function Empty({ id, text }: { id: string; text: string }) {
  return <Text style={[s.detail, s.pad]} testID={id}>{text}</Text>;
}
function WriteError({ w }: { w: ApiWrite<unknown> | null }) {
  if (!w || w.state === 'done') return null;
  return <Text style={[s.detail, s.pad, { color: color.signal }]} testID="shared-write-error">{writeFailureText(w)}</Text>;
}

// ── Notes ───────────────────────────────────────────────────────────────────

function NotesTab({ tripId, client }: { tripId: string; client: typeof api }) {
  const fn = useCallback(() => client.fetchNotes(tripId), [client, tripId]);
  const { read, run } = useRead(fn);
  const [text, setText] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiWrite<unknown> | null>(null);

  async function add() {
    const content = text.trim();
    if (!content) return;
    setBusy(true); setErr(null);
    const w = await client.createNote(tripId, { title: null, content, isPrivate: priv });
    setBusy(false);
    if (w.state === 'done') { setText(''); void run(); } else setErr(w);
  }

  return (
    <View>
      <View style={s.form}>
        <TextInput value={text} onChangeText={setText} placeholder="Write a note for the crew…" placeholderTextColor={color.mute} style={s.input} multiline testID="shared-note-input" />
        <View style={s.formRow}>
          <Lock size={12} color={color.mute} />
          <Text style={[s.detail, { marginTop: 0, flex: 1 }]}>Only me and the owner</Text>
          <Switch value={priv} onValueChange={setPriv} testID="shared-note-private" />
          <Pressable onPress={() => void add()} disabled={busy || !text.trim()} style={[s.smallBtn, s.primary, (busy || !text.trim()) && { opacity: 0.5 }]} testID="shared-note-add" accessibilityRole="button">
            <Text style={[s.smallBtnText, { color: '#fff' }]}>{busy ? 'Saving…' : 'Add note'}</Text>
          </Pressable>
        </View>
        <WriteError w={err} />
      </View>
      {read === undefined ? <Loading id="shared-notes-loading" />
        : read.state === 'off' ? null
        : read.state === 'unavailable' ? <Failed id="shared-notes-unavailable" what="notes" detail={read.detail} onRetry={() => void run()} />
        : read.data.length === 0 ? <Empty id="shared-notes-empty" text="No notes yet." />
        : read.data.map((n) => (
          <View key={n.id} style={s.item} testID={`shared-note-${n.id}`}>
            {n.title ? <Text style={s.title}>{n.title}</Text> : null}
            <Text style={s.body}>{n.content}</Text>
            <Text style={s.detail}>{n.is_private ? 'Private · ' : ''}{new Date(n.created_at).toLocaleDateString()}</Text>
          </View>
        ))}
    </View>
  );
}

// ── Documents ───────────────────────────────────────────────────────────────

function DocumentsTab({ tripId, client }: { tripId: string; client: typeof api }) {
  const fn = useCallback(() => client.fetchDocuments(tripId), [client, tripId]);
  const { read, run } = useRead(fn);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<api.DocumentType>('itinerary');
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiWrite<unknown> | null>(null);
  const [open, setOpen] = useState<Record<string, ApiRead<api.TripDocument> | 'loading'>>({});

  async function add() {
    if (!title.trim()) return;
    setBusy(true); setErr(null);
    const w = await client.createDocument(tripId, { title: title.trim(), content: content.trim() || null, documentType: type, isPrivate: priv });
    setBusy(false);
    if (w.state === 'done') { setTitle(''); setContent(''); void run(); } else setErr(w);
  }
  async function toggle(id: string) {
    if (open[id]) { setOpen((o) => { const n = { ...o }; delete n[id]; return n; }); return; }
    setOpen((o) => ({ ...o, [id]: 'loading' }));
    const r = await client.fetchDocument(tripId, id);
    setOpen((o) => ({ ...o, [id]: r }));
  }

  return (
    <View>
      <View style={s.form}>
        <TextInput value={title} onChangeText={setTitle} placeholder="Title (e.g. Flight TP 123)" placeholderTextColor={color.mute} style={s.input} testID="shared-doc-title" />
        <TextInput value={content} onChangeText={setContent} placeholder="Booking reference, seat, times…" placeholderTextColor={color.mute} style={s.input} multiline testID="shared-doc-content" />
        <View style={s.chips}>
          {api.DOCUMENT_TYPES.map((d) => (
            <Pressable key={d} onPress={() => setType(d)} style={[s.chip, type === d && s.chipOn]} testID={`shared-doc-type-${d}`} accessibilityRole="button" accessibilityState={{ selected: type === d }}>
              <Text style={[s.chipText, type === d && { color: '#fff' }]}>{api.DOCUMENT_TYPE_LABEL[d]}</Text>
            </Pressable>
          ))}
        </View>
        <View style={s.formRow}>
          <Lock size={12} color={color.mute} />
          <Text style={[s.detail, { marginTop: 0, flex: 1 }]}>Only me and the owner</Text>
          <Switch value={priv} onValueChange={setPriv} testID="shared-doc-private" />
          <Pressable onPress={() => void add()} disabled={busy || !title.trim()} style={[s.smallBtn, s.primary, (busy || !title.trim()) && { opacity: 0.5 }]} testID="shared-doc-add" accessibilityRole="button">
            <Text style={[s.smallBtnText, { color: '#fff' }]}>{busy ? 'Saving…' : 'Add document'}</Text>
          </Pressable>
        </View>
        <Text style={s.detail}>Documents are text: keep the reference here, not the file.</Text>
        <WriteError w={err} />
      </View>
      {read === undefined ? <Loading id="shared-docs-loading" />
        : read.state === 'off' ? null
        : read.state === 'unavailable' ? <Failed id="shared-docs-unavailable" what="documents" detail={read.detail} onRetry={() => void run()} />
        : read.data.length === 0 ? <Empty id="shared-docs-empty" text="No documents yet." />
        : read.data.map((d) => {
          const o = open[d.id];
          return (
            <Pressable key={d.id} style={s.item} onPress={() => void toggle(d.id)} testID={`shared-doc-${d.id}`} accessibilityRole="button">
              <Text style={s.title}>{d.title}</Text>
              <Text style={s.detail}>{api.DOCUMENT_TYPE_LABEL[d.document_type as api.DocumentType] ?? d.document_type}{d.is_private ? ' · Private' : ''}</Text>
              {o === 'loading' ? <ActivityIndicator size="small" color={color.signal} />
                : o?.state === 'ok' ? <Text style={s.body} testID={`shared-doc-body-${d.id}`}>{o.data.content || 'No text in this document.'}</Text>
                : o?.state === 'unavailable' ? <Text style={[s.detail, { color: color.signal }]}>Couldn&apos;t open it ({o.detail}).</Text>
                : null}
            </Pressable>
          );
        })}
    </View>
  );
}

// ── Checklists ──────────────────────────────────────────────────────────────

function ChecklistsTab({ tripId, client }: { tripId: string; client: typeof api }) {
  const fn = useCallback(() => client.fetchChecklists(tripId), [client, tripId]);
  const { read, run, setRead } = useRead(fn);
  const [newList, setNewList] = useState('');
  const [newItem, setNewItem] = useState<Record<string, string>>({});
  const [err, setErr] = useState<ApiWrite<unknown> | null>(null);

  async function addList() {
    if (!newList.trim()) return;
    setErr(null);
    const w = await client.createChecklist(tripId, newList.trim());
    if (w.state === 'done') { setNewList(''); void run(); } else setErr(w);
  }
  async function addItem(c: api.Checklist) {
    const label = (newItem[c.id] ?? '').trim();
    if (!label) return;
    setErr(null);
    const w = await client.addChecklistItem(tripId, c.id, label, c.items.length);
    if (w.state === 'done') { setNewItem((m) => ({ ...m, [c.id]: '' })); void run(); } else setErr(w);
  }
  async function tick(c: api.Checklist, i: api.ChecklistItem) {
    setErr(null);
    const w = await client.setChecklistItemDone(tripId, c.id, i.id, !i.is_done);
    // Only the server's answer ticks the box.
    if (w.state === 'done' && read?.state === 'ok') {
      setRead({ state: 'ok', data: read.data.map((l) => l.id !== c.id ? l : { ...l, items: l.items.map((x) => x.id === i.id ? { ...x, is_done: !i.is_done } : x) }) });
    } else if (w.state !== 'done') setErr(w);
  }

  return (
    <View>
      <View style={[s.form, s.formRow]}>
        <TextInput value={newList} onChangeText={setNewList} placeholder="New checklist (e.g. Packing)" placeholderTextColor={color.mute} style={[s.input, { flex: 1 }]} testID="shared-checklist-title" />
        <Pressable onPress={() => void addList()} style={[s.smallBtn, s.primary]} testID="shared-checklist-add" accessibilityRole="button"><Plus size={14} color="#fff" /></Pressable>
      </View>
      <WriteError w={err} />
      {read === undefined ? <Loading id="shared-checklists-loading" />
        : read.state === 'off' ? null
        : read.state === 'unavailable' ? <Failed id="shared-checklists-unavailable" what="checklists" detail={read.detail} onRetry={() => void run()} />
        : read.data.length === 0 ? <Empty id="shared-checklists-empty" text="No checklists yet." />
        : read.data.map((c) => (
          <View key={c.id} style={s.item} testID={`shared-checklist-${c.id}`}>
            <Text style={s.title}>{c.title}</Text>
            <Text style={s.detail}>{api.checklistProgress(c)}</Text>
            {c.items.map((i) => (
              <Pressable key={i.id} onPress={() => void tick(c, i)} style={s.check} testID={`shared-checklist-item-${i.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: i.is_done }}>
                {i.is_done ? <SquareCheck size={15} color={color.success} /> : <Square size={15} color={color.mute} />}
                <Text style={[s.body, i.is_done && { textDecorationLine: 'line-through', color: color.mute }]}>{i.label}</Text>
              </Pressable>
            ))}
            <View style={s.formRow}>
              <TextInput value={newItem[c.id] ?? ''} onChangeText={(v) => setNewItem((m) => ({ ...m, [c.id]: v }))} placeholder="Add an item" placeholderTextColor={color.mute} style={[s.input, { flex: 1 }]} testID={`shared-checklist-item-input-${c.id}`} />
              <Pressable onPress={() => void addItem(c)} style={s.smallBtn} testID={`shared-checklist-item-add-${c.id}`} accessibilityRole="button"><Plus size={14} color={color.ink} /></Pressable>
            </View>
          </View>
        ))}
    </View>
  );
}

// ── Reminders ───────────────────────────────────────────────────────────────

/** "2026-10-01 09:00" in local time → ISO, or null. */
export function parseLocalDateTime(v: string): string | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function RemindersTab({ tripId, client }: { tripId: string; client: typeof api }) {
  const fn = useCallback(() => client.fetchTripReminders(tripId), [client, tripId]);
  const { read, run } = useRead(fn);
  const [here, setHere] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [err, setErr] = useState<ApiWrite<unknown> | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  useEffect(() => { client.reminderAlertsHere().then(setHere).catch(() => setHere(new Set())); }, [client, read]);

  async function add() {
    setErr(null); setFormErr(null);
    const at = parseLocalDateTime(when);
    if (!title.trim() || !at) { setFormErr('Give it a title and a time as YYYY-MM-DD HH:MM.'); return; }
    if (Date.parse(at) <= Date.now()) { setFormErr('Pick a time in the future.'); return; }
    const w = await client.createTripReminder(tripId, title.trim(), at);
    if (w.state === 'done') { setTitle(''); setWhen(''); void run(); } else setErr(w);
  }
  function remove(r: api.TripReminder) {
    Alert.alert('Delete this reminder?', r.title, [
      { text: 'Keep', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { const w = await client.deleteTripReminder(tripId, r.id); if (w.state === 'done') void run(); else setErr(w); } },
    ]);
  }

  return (
    <View>
      <View style={s.form}>
        <TextInput value={title} onChangeText={setTitle} placeholder="Remind me to… (e.g. Check in online)" placeholderTextColor={color.mute} style={s.input} testID="shared-reminder-title" />
        <View style={s.formRow}>
          <TextInput value={when} onChangeText={setWhen} placeholder="YYYY-MM-DD HH:MM" placeholderTextColor={color.mute} style={[s.input, { flex: 1 }]} autoCapitalize="none" testID="shared-reminder-when" />
          <Pressable onPress={() => void add()} style={[s.smallBtn, s.primary]} testID="shared-reminder-add" accessibilityRole="button"><Text style={[s.smallBtnText, { color: '#fff' }]}>Add</Text></Pressable>
        </View>
        {formErr ? <Text style={[s.detail, { color: color.signal }]}>{formErr}</Text> : null}
        <Text style={s.detail}>Your trip reminders follow your account; each rings on the device you set it on.</Text>
        <WriteError w={err} />
      </View>
      {read === undefined ? <Loading id="shared-reminders-loading" />
        : read.state === 'off' ? null
        : read.state === 'unavailable' ? <Failed id="shared-reminders-unavailable" what="your reminders" detail={read.detail} onRetry={() => void run()} />
        : read.data.length === 0 ? <Empty id="shared-reminders-empty" text="No trip reminders yet." />
        : read.data.map((r) => (
          <View key={r.id} style={[s.item, s.formRow]} testID={`shared-reminder-${r.id}`}>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{r.title}</Text>
              <Text style={s.detail}>{new Date(r.remind_at).toLocaleString()} · {here.has(r.id) ? 'rings on this device' : 'set on another device'}</Text>
            </View>
            <Pressable onPress={() => remove(r)} hitSlop={8} testID={`shared-reminder-delete-${r.id}`} accessibilityRole="button" accessibilityLabel={`Delete reminder ${r.title}`}>
              <Trash2 size={14} color={color.mute} />
            </Pressable>
          </View>
        ))}
    </View>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

function ActivityTab({ tripId, client }: { tripId: string; client: typeof api }) {
  const fn = useCallback(() => client.fetchActivity(tripId), [client, tripId]);
  const { read, run } = useRead(fn);
  if (read === undefined) return <Loading id="shared-activity-loading" />;
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    if (read.status === 403) return <Empty id="shared-activity-hosts-only" text="Only the owner and co-hosts can see the activity feed." />;
    return <Failed id="shared-activity-unavailable" what="the activity feed" detail={read.detail} onRetry={() => void run()} />;
  }
  if (read.data.length === 0) return <Empty id="shared-activity-empty" text="Nothing has happened on this trip yet." />;
  return (
    <View>
      {read.data.map((a) => (
        <View key={a.id} style={s.item} testID={`shared-activity-${a.id}`}>
          <Text style={s.body}>{api.activityText(a)}</Text>
          <Text style={s.detail}>{new Date(a.created_at).toLocaleString()}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────

export function TripSharedContentSection({ tripId, isHost, client = api }: Props) {
  const tabs: Tab[] = isHost ? ['notes', 'documents', 'checklists', 'reminders', 'activity'] : ['notes', 'documents', 'checklists', 'reminders'];
  const [tab, setTab] = useState<Tab>('notes');
  return (
    <View style={s.wrap} testID="trip-shared-content">
      <Text style={s.heading}>Trip notes, documents & lists</Text>
      <View style={s.tabs}>
        {tabs.map((k) => {
          const Icon = TAB_ICON[k];
          return (
            <Pressable key={k} onPress={() => setTab(k)} style={[s.tab, tab === k && s.tabOn]} testID={`shared-tab-${k}`} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
              <Icon size={12} color={tab === k ? '#fff' : color.ink} />
              <Text style={[s.tabText, tab === k && { color: '#fff' }]}>{TAB_LABEL[k]}</Text>
            </Pressable>
          );
        })}
      </View>
      {tab === 'notes' ? <NotesTab tripId={tripId} client={client} />
        : tab === 'documents' ? <DocumentsTab tripId={tripId} client={client} />
        : tab === 'checklists' ? <ChecklistsTab tripId={tripId} client={client} />
        : tab === 'reminders' ? <RemindersTab tripId={tripId} client={client} />
        : <ActivityTab tripId={tripId} client={client} />}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', paddingBottom: space.sm },
  heading: { ...t.small, fontWeight: '700', color: color.ink, paddingHorizontal: space.lg, paddingTop: space.md },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, paddingHorizontal: space.lg, paddingVertical: space.sm },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  tabOn: { backgroundColor: color.deep, borderColor: color.deep },
  tabText: { ...t.stamp, color: color.ink },
  form: { paddingHorizontal: space.lg, gap: space.xs },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: { ...t.small, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, minHeight: 36 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipOn: { backgroundColor: color.deep, borderColor: color.deep },
  chipText: { ...t.stamp, color: color.ink },
  item: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: color.haze },
  check: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  stateRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  pad: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  body: { ...t.small, color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  smallBtn: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  smallBtnText: { ...t.small, color: color.ink },
  primary: { backgroundColor: color.signal, borderColor: color.signal },
});
