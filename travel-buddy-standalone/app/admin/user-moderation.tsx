/**
 * Admin — User moderation.
 *
 * Look up a user by email or handle, inspect their account state and
 * restriction/report history, and apply or lift moderation actions
 * (warn / restrict / suspend / ban / restore / restrict-bio /
 * restrict-messaging / restrict-visibility / hide-posts).
 *
 * Every mutating action requires an explicit reason (except warn and
 * restore, which the backend treats as optional) and — since none of these
 * actions has an "undo" of its own besides /restore — every one of them is
 * gated behind the ReasonPromptModal's destructive styling, with an extra
 * native confirm step for suspend/ban specifically (the two that also flip
 * profiles.account_status for the whole account).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';
import {
  lookupUser,
  fetchUserSummary,
  warnUser,
  restrictUser,
  suspendUser,
  banUser,
  restoreUser,
  restrictBio,
  restrictMessaging,
  restrictVisibility,
  hidePosts,
  readModerationReportHandoff,
  type ModerationReportHandoff,
  type UserSummary,
} from '../../src/services/adminUsers';

const STATUS_COLORS: Record<string, string> = {
  active:     '#10B981',
  suspended:  '#F59E0B',
  banned:     '#EF4444',
  restricted: '#F59E0B',
};

type ActionSlug =
  | 'warn' | 'restrict' | 'suspend' | 'ban' | 'restore'
  | 'restrict-bio' | 'restrict-messaging' | 'restrict-visibility' | 'hide-posts';

interface ActionDef {
  slug: ActionSlug;
  label: string;
  destructive: boolean;
  requireReason: boolean;
  promptMessage: string;
  /** Extra native confirm before the reason prompt even opens. */
  confirmFirst?: string;
}

const ACTIONS: ActionDef[] = [
  { slug: 'warn',    label: 'Warn',    destructive: false, requireReason: false, promptMessage: 'Optional note for the warning (visible in the audit trail).' },
  { slug: 'restrict', label: 'Restrict interactions', destructive: true, requireReason: true, promptMessage: 'Why is this user being restricted?' },
  {
    slug: 'suspend', label: 'Suspend', destructive: true, requireReason: true,
    promptMessage: 'Why is this account being suspended?',
    confirmFirst: 'This sets the account status to "suspended" and blocks sign-in until an admin restores it. Continue?',
  },
  {
    slug: 'ban', label: 'Ban', destructive: true, requireReason: true,
    promptMessage: 'Why is this account being permanently banned?',
    confirmFirst: 'This permanently bans the account. It can only be reversed with Restore. Continue?',
  },
  { slug: 'restore', label: 'Restore account', destructive: false, requireReason: false, promptMessage: 'Optional note for restoring this account to active.' },
  { slug: 'restrict-bio', label: 'Clear & lock bio', destructive: true, requireReason: true, promptMessage: 'Why is the bio being cleared?' },
  { slug: 'restrict-messaging', label: 'Restrict messaging', destructive: true, requireReason: true, promptMessage: 'Why is messaging being restricted?' },
  { slug: 'restrict-visibility', label: 'Force profile private', destructive: true, requireReason: true, promptMessage: 'Why is the profile being forced private?' },
  { slug: 'hide-posts', label: 'Hide all posts', destructive: true, requireReason: true, promptMessage: 'Why are this user\u2019s posts being hidden?' },
];

function runAction(slug: ActionSlug, userId: string, reason: string, reportId?: string) {
  const r = reason || null;
  switch (slug) {
    case 'warn':                return warnUser(userId, r, reportId);
    case 'restrict':             return restrictUser(userId, reason, reportId);
    case 'suspend':              return suspendUser(userId, reason, undefined, reportId);
    case 'ban':                  return banUser(userId, reason, reportId);
    case 'restore':              return restoreUser(userId, r);
    case 'restrict-bio':         return restrictBio(userId, reason);
    case 'restrict-messaging':   return restrictMessaging(userId, reason);
    case 'restrict-visibility':  return restrictVisibility(userId, reason);
    case 'hide-posts':           return hidePosts(userId, reason);
  }
}

export default function UserModerationScreen() {
  useRequireAdmin();
  const params = useLocalSearchParams<{ userId?: string | string[]; reportId?: string | string[] }>();
  const handoff = readModerationReportHandoff(params.userId, params.reportId);
  const invalidHandoff = !handoff && (params.userId !== undefined || params.reportId !== undefined);
  return <UserModerationForm key={JSON.stringify([params.userId, params.reportId])} initialHandoff={handoff} invalidHandoff={invalidHandoff} />;
}

const REPORT_ACTIONS: readonly ActionSlug[] = ['warn', 'restrict', 'suspend', 'ban'];
type PendingAction = ActionDef & { userId: string; reportId?: string; revision: number };

function UserModerationForm({ initialHandoff, invalidHandoff }: { initialHandoff: ModerationReportHandoff | null; invalidHandoff: boolean }) {

  const [query, setQuery]         = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(invalidHandoff ? 'Invalid report handoff. Return to the report queue and select a reported user.' : null);
  const [userId, setUserId]       = useState<string | null>(initialHandoff?.userId ?? null);
  const [reportId, setReportId]   = useState<string | undefined>(initialHandoff?.reportId);
  const [summary, setSummary]     = useState<UserSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [pendingAction, setPendingAction]   = useState<PendingAction | null>(null);
  const [actioning, setActioning] = useState<ActionSlug | null>(null);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const actioningRef = useRef(false);
  const initialUserId = initialHandoff?.userId;

  const loadSummary = useCallback(async (id: string, revision: number) => {
    if (!mountedRef.current || revision !== revisionRef.current) return;
    setLoadingSummary(true);
    setSummary(null);
    setSearchError(null);
    try {
      const res = await fetchUserSummary(id);
      if (!mountedRef.current || revision !== revisionRef.current) return;
      if (res.ok && res.data?.profile?.id?.toLowerCase() === id.toLowerCase()) {
        setSummary(res.data);
      } else {
        setSearchError(res.ok ? 'The summary does not match the selected user. Nothing can be changed.' : res.error);
      }
    } catch (error) {
      if (mountedRef.current && revision === revisionRef.current) setSearchError(error instanceof Error ? error.message : 'Could not load user summary');
    } finally {
      if (mountedRef.current && revision === revisionRef.current) setLoadingSummary(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const revision = ++revisionRef.current;
    if (initialUserId) void loadSummary(initialUserId, revision);
    return () => { mountedRef.current = false; };
  }, [initialUserId, loadSummary]);

  const resetTarget = () => {
    revisionRef.current++;
    setUserId(null);
    setReportId(undefined);
    setSummary(null);
    setPendingAction(null);
    setSearchError(null);
    setLoadingSummary(false);
    setSearching(false);
    return revisionRef.current;
  };

  const onSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const revision = resetTarget();
    setSearching(true);
    try {
      const isEmail = trimmed.includes('@');
      const res = await lookupUser(isEmail ? { email: trimmed } : { handle: trimmed });
      if (!mountedRef.current || revision !== revisionRef.current) return;
      if (!res.ok) { setSearchError(res.error); return; }
      const id = res.data.profile.id;
      setUserId(id);
      await loadSummary(id, revision);
    } catch (error) {
      if (mountedRef.current && revision === revisionRef.current) setSearchError(error instanceof Error ? error.message : 'Could not look up user');
    } finally {
      if (mountedRef.current && revision === revisionRef.current) setSearching(false);
    }
  };

  const cancelPending = (revision: number) => {
    if (!mountedRef.current || revision !== revisionRef.current) return;
    revisionRef.current++;
    setPendingAction(null);
  };

  const beginAction = (def: ActionDef) => {
    if (!mountedRef.current || actioningRef.current || !userId || !summary || (reportId && !REPORT_ACTIONS.includes(def.slug))) return;
    const revision = ++revisionRef.current;
    const pending = { ...def, userId, reportId, revision };
    setPendingAction(null);
    if (def.confirmFirst) {
      Alert.alert('Confirm', def.confirmFirst, [
        { text: 'Cancel', style: 'cancel', onPress: () => cancelPending(revision) },
        { text: 'Continue', style: 'destructive', onPress: () => {
          if (mountedRef.current && revision === revisionRef.current) setPendingAction(pending);
        } },
      ]);
    } else {
      setPendingAction(pending);
    }
  };

  const onSubmitAction = async (reason: string) => {
    const def = pendingAction;
    if (!mountedRef.current || !def || def.revision !== revisionRef.current || actioningRef.current) return;
    const revision = ++revisionRef.current;
    actioningRef.current = true;
    setPendingAction(null);
    setActioning(def.slug);
    try {
      const res = await runAction(def.slug, def.userId, reason, def.reportId);
      if (!mountedRef.current || revision !== revisionRef.current) return;
      if (!res.ok) {
        Alert.alert(`${def.label} failed`, res.error);
      } else {
        await loadSummary(def.userId, revision);
      }
    } catch (error) {
      if (mountedRef.current && revision === revisionRef.current) Alert.alert(`${def.label} failed`, error instanceof Error ? error.message : 'Request failed');
    } finally {
      actioningRef.current = false;
      if (mountedRef.current) setActioning(null);
    }
  };

  const profile = summary?.profile;
  const currentStatus = profile?.account_status ?? 'active';

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </Pressable>
        <Text style={s.title}>User Moderation</Text>
      </View>

      <View style={s.searchRow}>
        <TextInput
          style={s.searchInput}
          value={query}
          onChangeText={(value) => { setQuery(value); resetTarget(); }}
          placeholder="Email or @handle"
          placeholderTextColor="#9CA3AF"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={onSearch}
          testID="user-search-input"
        />
        <Pressable style={s.searchBtn} onPress={onSearch} disabled={searching} testID="user-search-btn">
          {searching ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.searchBtnText}>Search</Text>}
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        {reportId ? (
          <View style={s.section}>
            <Text style={s.sectionTitle} testID="moderation-report-link">Report {reportId} is linked to this action.</Text>
            <Text style={s.meta}>Choose an action and confirm it below. This does not close the report. Searching for another user cancels this handoff.</Text>
            <Pressable accessibilityRole="button" testID="cancel-report-handoff" onPress={() => { resetTarget(); setQuery(''); }}>
              <Text style={s.backText}>Cancel report handoff</Text>
            </Pressable>
          </View>
        ) : null}
        {searchError && (
          <View style={s.errorBox} testID="user-search-error" accessibilityRole="alert">
            <Text style={s.errorText}>{searchError}</Text>
            {userId ? <Pressable accessibilityRole="button" testID="retry-user-summary" onPress={() => { void loadSummary(userId, ++revisionRef.current); }}><Text style={s.backText}>Retry user summary</Text></Pressable> : null}
          </View>
        )}

        {loadingSummary && (
          <View style={s.centered}><ActivityIndicator size="large" color="#3B82F6" /></View>
        )}

        {profile && summary && !loadingSummary && (
          <>
            <View style={s.card}>
              <View style={s.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{profile.display_name || profile.name || profile.handle || profile.id}</Text>
                  <Text style={s.handle}>@{profile.handle ?? profile.username ?? '—'}</Text>
                </View>
                <View style={[s.statusBadge, { backgroundColor: `${STATUS_COLORS[currentStatus] ?? '#6B7280'}22` }]}>
                  <Text style={[s.statusText, { color: STATUS_COLORS[currentStatus] ?? '#6B7280' }]}>{currentStatus}</Text>
                </View>
              </View>
              <Text style={s.meta}>Role: {profile.role ?? 'user'} · Verified: {profile.verified ? 'yes' : 'no'}</Text>
              <Text style={s.meta}>Joined {new Date(profile.created_at).toLocaleDateString()}</Text>
              <Text style={s.meta}>
                Blocks: {summary.blockCount} · Mutes: {summary.muteCount} · Restricts placed by user: {summary.restrictCount}
              </Text>
            </View>

            <View style={s.section}>
              <Text style={s.sectionTitle}>Moderation actions</Text>
              <View style={s.actionsWrap}>
                {ACTIONS.filter((def) => !reportId || REPORT_ACTIONS.includes(def.slug)).map((def) => (
                  <Pressable
                    key={def.slug}
                    style={[s.actionChip, def.destructive && s.actionChipDestructive]}
                    onPress={() => beginAction(def)}
                    disabled={actioning != null}
                    testID={`action-${def.slug}`}
                  >
                    {actioning === def.slug ? (
                      <ActivityIndicator size="small" color={def.destructive ? '#EF4444' : '#3B82F6'} />
                    ) : (
                      <Text style={[s.actionChipText, def.destructive && s.actionChipTextDestructive]}>{def.label}</Text>
                    )}
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={s.section}>
              <Text style={s.sectionTitle}>Account state history</Text>
              {summary.accountStates.length === 0 ? (
                <Text style={s.emptyText}>No account state changes recorded.</Text>
              ) : summary.accountStates.map((st, i) => (
                <View key={i} style={s.historyRow}>
                  <Text style={s.historyState}>{st.state}</Text>
                  {st.reason ? <Text style={s.historyDetail}>{st.reason}</Text> : null}
                  <Text style={s.historyDate}>{new Date(st.created_at).toLocaleString()}{st.expires_at ? ` · expires ${new Date(st.expires_at).toLocaleDateString()}` : ''}</Text>
                </View>
              ))}
            </View>

            <View style={s.section}>
              <Text style={s.sectionTitle}>Moderation action log</Text>
              {summary.moderationActions.length === 0 ? (
                <Text style={s.emptyText}>No moderation actions recorded.</Text>
              ) : summary.moderationActions.map((a) => (
                <View key={a.id} style={s.historyRow}>
                  <Text style={s.historyState}>{a.action_type.replace(/_/g, ' ')}</Text>
                  {a.reason ? <Text style={s.historyDetail}>{a.reason}</Text> : null}
                  <Text style={s.historyDate}>{new Date(a.created_at).toLocaleString()}</Text>
                </View>
              ))}
            </View>

            <View style={s.section}>
              <Text style={s.sectionTitle}>Reports about this user ({summary.reportsReceived.length})</Text>
              {summary.reportsReceived.length === 0 ? (
                <Text style={s.emptyText}>None.</Text>
              ) : summary.reportsReceived.map((r) => (
                <View key={r.id} style={s.historyRow}>
                  <Text style={s.historyState}>{r.reason_code.replace(/_/g, ' ')} · {r.status}</Text>
                  <Text style={s.historyDate}>{new Date(r.created_at).toLocaleString()}</Text>
                </View>
              ))}
            </View>

            {summary.trustRestrictions.length > 0 && (
              <View style={s.section}>
                <Text style={s.sectionTitle}>Active trust restrictions</Text>
                {summary.trustRestrictions.map((tr) => (
                  <View key={tr.id} style={s.historyRow}>
                    <Text style={s.historyState}>{tr.restriction_type}</Text>
                    {tr.reason ? <Text style={s.historyDetail}>{tr.reason}</Text> : null}
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      <ReasonPromptModal
        visible={pendingAction != null}
        title={pendingAction?.label ?? ''}
        message={pendingAction?.promptMessage ?? ''}
        placeholder="Reason…"
        confirmLabel={pendingAction?.label ?? 'Confirm'}
        requireValue={pendingAction?.requireReason ?? true}
        destructive={pendingAction?.destructive ?? false}
        onCancel={() => { if (pendingAction) cancelPending(pendingAction.revision); }}
        onSubmit={onSubmitAction}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#F9FAFB' },
  header:     { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  backBtn:    { marginBottom: 8 },
  backText:   { fontSize: 14, color: '#3B82F6' },
  title:      { fontSize: 22, fontWeight: '700', color: '#111827' },

  searchRow:  { flexDirection: 'row', gap: 8, padding: 16, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  searchInput:{ flex: 1, borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: '#111827' },
  searchBtn:  { backgroundColor: '#3B82F6', borderRadius: 8, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  searchBtnText: { color: '#FFFFFF', fontWeight: '700' },

  body:       { padding: 16, gap: 12 },
  centered:   { paddingVertical: 32, alignItems: 'center' },
  errorBox:   { backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FCA5A5', borderRadius: 8, padding: 12 },
  errorText:  { color: '#EF4444', fontSize: 14 },

  card:       { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#E5E7EB', gap: 4 },
  cardTop:    { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  name:       { fontSize: 16, fontWeight: '700', color: '#111827' },
  handle:     { fontSize: 13, color: '#6B7280' },
  statusBadge:{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  statusText: { fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  meta:       { fontSize: 12, color: '#6B7280' },

  section:      { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#E5E7EB', gap: 8 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#374151' },
  emptyText:    { fontSize: 13, color: '#9CA3AF' },

  actionsWrap:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionChip:   { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE', minWidth: 90, alignItems: 'center' },
  actionChipDestructive: { backgroundColor: '#FEF2F2', borderColor: '#FCA5A5' },
  actionChipText: { fontSize: 13, fontWeight: '600', color: '#3B82F6' },
  actionChipTextDestructive: { color: '#EF4444' },

  historyRow:    { borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 8, gap: 2 },
  historyState:  { fontSize: 13, fontWeight: '600', color: '#111827', textTransform: 'capitalize' },
  historyDetail: { fontSize: 12, color: '#374151' },
  historyDate:   { fontSize: 11, color: '#9CA3AF' },
});
