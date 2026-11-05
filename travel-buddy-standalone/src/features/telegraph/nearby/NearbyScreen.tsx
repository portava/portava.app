import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../../../context/SessionContext.tsx';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { currentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';
import { searchUsers, type TravelerSearchResult } from '../../../services/follows.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';
import { loadWindowSignal, nearbyIdentity, nearbyRequest, NearbyUnavailable, saveWindowSignal, type Audience, type EtaGrant, type Geography, type Proximity, type ReachablePeople, type SharingWindow } from './nearbyApi.ts';

interface Context { owner: MessagingOwnerRequest; signal: AbortSignal; revision: number }
const current = (ctx: Context) => ctx.owner.isCurrent() && !ctx.signal.aborted;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not complete this request. Try again.';
const dateText = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time unavailable';

function useRead<T>(ctx: Context, read: () => Promise<T>, deps: React.DependencyList) {
  const [state, setState] = useState<{ value?: T; error?: string; unavailable?: boolean; loading: boolean }>({ loading: true });
  const [revision, reload] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    void read().then(value => { if (active && current(ctx)) setState({ value, loading: false }); })
      .catch(error => { if (active && current(ctx)) setState({ error: errorText(error), unavailable: error instanceof NearbyUnavailable, loading: false }); });
    return () => { active = false; };
  // read is supplied alongside its explicit dependencies, so state updates do not refetch.
  }, [ctx, revision, ...deps]);
  const refresh = useCallback(() => reload(n => n + 1), []);
  return { ...state, reload: refresh };
}

function useAction(ctx: Context) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (action: () => Promise<void>, success: string) => {
    if (lock.current || !current(ctx)) return;
    lock.current = true; setBusy(true); setMessage(null);
    try { await action(); if (current(ctx)) setMessage(success); }
    catch (error) { if (current(ctx)) setMessage(errorText(error)); }
    finally { if (current(ctx)) { lock.current = false; setBusy(false); } }
  };
  return { busy, message, run };
}

function Copy({ children, title = false }: { children: React.ReactNode; title?: boolean }) {
  const p = useTelegraphPalette();
  return <Text style={[title ? styles.title : styles.copy, { color: title ? p.recvText : p.mute }]}>{children}</Text>;
}
function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const p = useTelegraphPalette();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, { borderColor: p.operational, opacity: disabled ? 0.5 : 1 }]}><Text style={{ color: p.operational, fontSize: 16, fontWeight: '600' }}>{label}</Text></Pressable>;
}
function Section({ children }: { children: React.ReactNode }) {
  const p = useTelegraphPalette();
  return <View style={[styles.section, { backgroundColor: p.surfaceRaised, borderColor: p.hairline }]}>{children}</View>;
}
function ReadState({ state }: { state: { loading: boolean; error?: string; unavailable?: boolean; reload: () => void } }) {
  return state.loading ? <ActivityIndicator accessibilityLabel="Loading Nearby" /> : state.error ? <><Copy>{state.error}</Copy>{!state.unavailable && <Button label="Retry" onPress={state.reload} />}</> : null;
}
function Choices<T extends string | null>({ label, values, selected, onSelect, disabled }: { label: string; values: Array<[T, string]>; selected: T; onSelect: (value: T) => void; disabled: boolean }) {
  const p = useTelegraphPalette();
  return <View style={styles.choices}><Copy title>{label}</Copy>{values.map(([value, text]) => <Pressable key={value ?? 'none'} accessibilityRole="radio" accessibilityState={{ checked: selected === value, disabled }} disabled={disabled} onPress={() => onSelect(value)} style={[styles.choice, { borderColor: selected === value ? p.operational : p.hairline }]}><Text style={{ color: p.recvText, fontSize: 16 }}>{selected === value ? '● ' : '○ '}{text}</Text></Pressable>)}</View>;
}

function Consent({ ctx }: { ctx: Context }) {
  const read = useRead(ctx, () => nearbyRequest<{ optedIn: boolean }>('/me/nearby-consent', ctx), []);
  const [draft, setDraft] = useState(false);
  const action = useAction(ctx);
  useEffect(() => { if (read.value) setDraft(read.value.optedIn); }, [read.value]);
  return <Section><Copy title>Appear in Nearby</Copy><Copy>Choose whether Nearby may show your published availability and permitted proximity. This does not turn on location access. Your window audience and privacy settings still apply.</Copy><ReadState state={read} />
    {read.value && <><View style={styles.row}><Copy>Nearby sharing</Copy><Switch accessibilityLabel="Nearby sharing" value={draft} disabled={action.busy} onValueChange={setDraft} /></View><Button label="Save Nearby setting" disabled={action.busy || draft === read.value.optedIn} onPress={() => void action.run(async () => { await nearbyRequest('/me/nearby-consent', ctx, 'PUT', { optedIn: draft }); read.reload(); }, 'Nearby setting saved.')} /></>}
    {action.message && <Copy>{action.message}</Copy>}
  </Section>;
}

function WindowEditor({ window, ctx, onClose }: { window: SharingWindow; ctx: Context; onClose: () => void }) {
  const read = useRead(ctx, () => loadWindowSignal(window.id, ctx), [window.id]);
  const [audience, setAudience] = useState<Audience>('mutual_follow_and_crew');
  const [proximity, setProximity] = useState<Proximity>('HIDDEN');
  const [geography, setGeography] = useState<Geography>(null);
  const action = useAction(ctx);
  useEffect(() => { if (read.value) { setAudience(read.value.audience); setProximity(read.value.signal.proximityVisibility); setGeography(read.value.signal.geographyScope); } }, [read.value]);
  return <View style={styles.choices}><ReadState state={read} />{read.value && <>
    <Choices label="Who can see this window" values={[["crew_only", 'Trip crew'], ['mutual_follow_and_crew', 'Mutual followers and trip crew'], ['public', 'Public']]} selected={audience} onSelect={setAudience} disabled={action.busy} />
    <Choices label="Proximity detail" values={[["HIDDEN", 'Hidden'], ['NEARBY', 'Nearby only'], ['DISTANCE_BUCKET', 'Approximate distance band'], ['ETA_IF_MUTUAL', 'ETA only with mutual permission']]} selected={proximity} onSelect={setProximity} disabled={action.busy} />
    <Copy>ETA requires both people to grant permission. Exact coordinates are never included in the Nearby list.</Copy>
    <Choices label="Area scope" values={[[null, 'No area scope'], ['neighborhood', 'Neighborhood'], ['city', 'City'], ['region', 'Region']]} selected={geography} onSelect={setGeography} disabled={action.busy} />
    <Button label="Save window sharing" disabled={action.busy} onPress={() => void action.run(async () => { await saveWindowSignal(window.id, audience, proximity, geography, ctx); read.reload(); }, 'Window sharing saved.')} />
  </>}{action.message && <Copy>{action.message}</Copy>}<Button label="Close window settings" disabled={action.busy} onPress={onClose} /></View>;
}

function Windows({ ctx, now }: { ctx: Context; now: number }) {
  const read = useRead(ctx, () => nearbyRequest<{ windows: SharingWindow[]; enabled: boolean }>('/me/availability-windows', ctx), []);
  const [selected, setSelected] = useState<string | null>(null);
  const windows = read.value?.windows.filter(window => Date.parse(window.endAt) > now) ?? [];
  return <Section><Copy title>Availability sharing</Copy><Copy>Choose an audience and proximity level for each availability window.</Copy><ReadState state={read} />
    {read.value && (read.value.enabled ? <>{!windows.length && <Copy>No current availability windows.</Copy>}{windows.map(window => <View key={window.id} style={styles.choices}><Copy title>{window.intents.length ? window.intents.join(' · ').replace(/_/g, ' ') : 'Available'}</Copy><Copy>{dateText(window.startAt)} — {dateText(window.endAt)}</Copy>{selected === window.id ? <WindowEditor window={window} ctx={ctx} onClose={() => setSelected(null)} /> : <Button label={`Edit sharing for ${dateText(window.startAt)}`} onPress={() => setSelected(window.id)} />}</View>)}<Button label="Edit availability" onPress={() => router.push('/passport/availability' as never)} /></> : <Copy>Availability windows are not available yet.</Copy>)}
  </Section>;
}

/** Load identities only for visible rows, using the existing privacy-filtered reader. */
function Identity({ userId, ctx, children }: { userId: string; ctx: Context; children?: React.ReactNode }) {
  const read = useRead(ctx, () => nearbyIdentity(userId, ctx), [userId]);
  return <View style={styles.choices}><Copy title>{read.value ?? (read.loading ? 'Loading traveler…' : 'Traveler unavailable')}</Copy>{read.error && <Button label="Retry traveler" onPress={read.reload} />}{read.value && <>{children}<Button label={`Open ${read.value}'s profile`} onPress={() => router.push({ pathname: '/passport/[username]', params: { username: userId } } as never)} /></>}</View>;
}

function EtaPermissions({ ctx, now }: { ctx: Context; now: number }) {
  const p = useTelegraphPalette();
  const read = useRead(ctx, () => nearbyRequest<{ grants: EtaGrant[] }>('/me/eta-grants', ctx), []);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<TravelerSearchResult[]>([]);
  const [chosen, setChosen] = useState<TravelerSearchResult | null>(null);
  const [hours, setHours] = useState('1');
  const [limit, setLimit] = useState(8);
  const search = useAction(ctx);
  const action = useAction(ctx);
  const grants = read.value?.grants.filter(grant => Date.parse(grant.expiresAt) > now) ?? [];
  const count = Number(hours);
  return <Section><Copy title>ETA permissions</Copy><Copy>Allow a selected traveler to use your ETA for up to 12 hours. It is shared only while both people have permission and their privacy settings allow it. You can withdraw at any time.</Copy><ReadState state={read} />{read.value && <>
    {!grants.length && <Copy>No active ETA permissions.</Copy>}
    {grants.slice(0, limit).map(grant => <View key={grant.userId} style={styles.choices}><Identity userId={grant.userId} ctx={ctx} /><Copy>{grant.mutual ? 'Mutual permission' : 'Waiting for their permission'} · until {dateText(grant.expiresAt)}</Copy><Button label="Withdraw ETA permission" disabled={action.busy} onPress={() => void action.run(async () => { await nearbyRequest(`/me/eta-grants/${encodeURIComponent(grant.userId)}`, ctx, 'DELETE'); read.reload(); }, 'ETA permission withdrawn.')} /></View>)}
    {grants.length > limit && <Button label="Show more permissions" onPress={() => setLimit(n => n + 8)} />}
    <TextInput accessibilityLabel="Search traveler for ETA permission" placeholder="Search name or handle" placeholderTextColor={p.mute} value={query} editable={!search.busy && !action.busy} onChangeText={value => { setQuery(value); setPeople([]); setChosen(null); }} style={[styles.input, { color: p.recvText, borderColor: p.hairline }]} />
    <Button label="Find traveler" disabled={search.busy || action.busy || query.trim().length < 2} onPress={() => void search.run(async () => { setPeople([]); setChosen(null); const result = await searchUsers(query.trim(), 8, { ...ctx, isCurrent: () => current(ctx), scope: currentDiscoveryScope() }); if (!result.ok || !result.data) throw new Error(result.message ?? 'Travelers could not be loaded. Try again.'); const choices = result.data.filter(person => person.id !== ctx.owner.ownerId); if (!choices.length) throw new Error('No travelers matched this search.'); if (current(ctx)) setPeople(choices); }, 'Search complete. Choose a traveler below.')} />
    {search.message && <Copy>{search.message}</Copy>}
    {people.map(person => <Button key={person.id} label={`${chosen?.id === person.id ? 'Selected: ' : 'Choose '}${person.username ? `@${person.username}` : person.displayName || 'Traveler'}`} onPress={() => setChosen(person)} disabled={action.busy} />)}
    {chosen && <><TextInput accessibilityLabel="ETA permission hours" value={hours} onChangeText={setHours} keyboardType="number-pad" style={[styles.input, { color: p.recvText, borderColor: p.hairline }]} /><Copy>Duration: 1–12 whole hours.</Copy><Button label="Grant ETA permission" disabled={action.busy || !Number.isInteger(count) || count < 1 || count > 12} onPress={() => void action.run(async () => { await nearbyRequest(`/me/eta-grants/${encodeURIComponent(chosen.id)}`, ctx, 'PUT', { hours: count }); if (current(ctx)) { setChosen(null); setPeople([]); setQuery(''); read.reload(); } }, 'ETA permission saved.')} /></>}
  </>}{action.message && <Copy>{action.message}</Copy>}</Section>;
}

const AVAILABILITY: Record<string, string> = { available_now: 'Available now', available_later: 'Available later', unavailable: 'Unavailable', unknown: 'Availability not shared' };
const BUCKETS: Record<string, string> = { same_place: 'Same place', walkable: 'Walkable', nearby: 'Nearby', same_area: 'Same area', same_city: 'Same city', same_region: 'Same region', far: 'Farther away', unknown: 'Proximity not shared' };
function Reachable({ ctx, now }: { ctx: Context; now: number }) {
  const read = useRead(ctx, () => nearbyRequest<ReachablePeople>('/nearby/reachable', ctx), []);
  const [limit, setLimit] = useState(8);
  useEffect(() => {
    if (!read.value?.enabled || !read.value.generatedAt) return;
    const timer = setTimeout(read.reload, 60_000);
    return () => clearTimeout(timer);
  }, [read.value, read.reload]);
  return <Section><Copy title>People from your circles and trips</Copy><Copy>Only information each traveler has chosen to share appears here. Results use approximate proximity.</Copy><ReadState state={read} />{read.value && (read.value.enabled ? <>
    {read.value.generatedAt && <Copy>Updated {dateText(read.value.generatedAt)}</Copy>}
    {!read.value.people.length && <Copy>No shared availability is visible right now.</Copy>}
    {read.value.people.slice(0, limit).map(person => <View key={person.personId} style={styles.choices}><Identity userId={person.personId} ctx={ctx}><Copy>{person.privacy.availabilityPublished && (!person.availability.publishedUntil || Date.parse(person.availability.publishedUntil) > now) ? AVAILABILITY[person.availability.state] ?? 'Availability not shared' : 'Availability not shared'}</Copy><Copy>{person.privacy.proximityPublished && person.proximity.freshness !== 'stale' ? BUCKETS[person.proximity.bucket] ?? 'Approximate proximity available' : 'Proximity not shared'}</Copy></Identity></View>)}
    {read.value.people.length > limit && <Button label="Show more travelers" onPress={() => setLimit(n => n + 8)} />}
    <Button label="Refresh nearby travelers" disabled={!!read.value.generatedAt && now < Date.parse(read.value.generatedAt) + 60_000} onPress={read.reload} />
  </> : <Copy>Nearby travelers are not available yet.</Copy>)}</Section>;
}

export function NearbyScreen() {
  const p = useTelegraphPalette();
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const [context, setContext] = useState<Context | null>(null);
  const revision = useRef(0);
  const [now, setNow] = useState(Date.now());
  useFocusEffect(useCallback(() => {
    let owner: MessagingOwnerRequest | null = null;
    let abort = new AbortController();
    const retire = () => { abort.abort(); owner?.invalidate(); setContext(null); };
    const enter = () => {
      abort.abort(); owner?.invalidate();
      owner = captureMessagingOwnerRequest(); abort = new AbortController();
      setContext(owner ? { owner, signal: abort.signal, revision: ++revision.current } : null);
      setNow(Date.now());
    };
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') enter();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    // Drop sensitive screen state when backgrounded; focus alone does not cover app suspension.
    const sub = AppState.addEventListener('change', state => { if (state === 'active') enter(); else retire(); });
    return () => { clearInterval(timer); sub.remove(); retire(); };
  }, [userId]));
  const ctx = useMemo(() => context && context.owner.ownerId === userId && current(context) ? context : null, [context, userId]);
  return <View style={{ flex: 1, backgroundColor: p.surface, paddingTop: insets.top }}><View style={styles.header}><Button label="Back" onPress={() => router.back()} /><Copy title>Nearby & availability</Copy></View><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 16 }}>
    {ctx ? <View key={ctx.revision} style={styles.choices}><Consent ctx={ctx} /><Windows ctx={ctx} now={now} /><EtaPermissions ctx={ctx} now={now} /><Reachable ctx={ctx} now={now} /></View> : <Copy>Sign in to manage Nearby.</Copy>}
  </ScrollView></View>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingHorizontal: 16, gap: 16 },
  section: { padding: 16, borderWidth: 1, borderRadius: 16, gap: 12 },
  title: { fontSize: 18, fontWeight: '700' }, copy: { fontSize: 15, lineHeight: 22 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  button: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center' },
  choices: { gap: 12 }, choice: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 10 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 },
});
