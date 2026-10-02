/**
 * Admin — A person's stamps: award, revoke, restore (testing-mode WP-21, PASS-F23).
 *
 * Find a person by @handle (GET /api/admin/users) or paste their user id, then:
 *   - see every stamp they hold, revoked ones included, with its id
 *     (GET /api/admin/stamps/users/:userId/stamps);
 *   - award a stamp by definition slug (POST /api/admin/stamps/award);
 *   - revoke or restore one (POST /api/admin/stamps/:userStampId/revoke|restore).
 * Every action needs a reason; the server writes it to stamp_award_events.
 *
 * Admin-only on the server (requireAdmin). The list is re-read after every
 * action, so what is shown is what the server holds — never an optimistic guess.
 * Campaigns stay API-only (docs/ops/testing-mode-flows.md).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { lookupUser } from '../../src/services/adminUsers';
import {
  awardStamp,
  isUuid,
  listUserStamps,
  restoreUserStamp,
  revokeUserStamp,
  type AdminApiResult,
  type AdminUserStamp,
} from '../../src/services/adminConsole';
import {
  AdminButton,
  AdminEmpty,
  AdminError,
  AdminHeader,
  AdminLoading,
  adminStyles as a,
} from '../../src/components/admin/AdminConsoleParts';

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: AdminUserStamp[]; total: number };

export default function AdminUserStampsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) router.replace('/(auth)/sign-in' as any);
  }, [isAuthed, sessionLoading]);

  const [query, setQuery] = useState('');
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
  const [data, setData] = useState<Load>({ state: 'idle' });

  const [reason, setReason] = useState('');
  const [slug, setSlug] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (userId: string) => {
    setData({ state: 'loading' });
    const r = await listUserStamps(userId);
    setData(r.ok ? { state: 'ready', rows: r.data.stamps, total: r.data.total } : { state: 'error', message: r.error });
  }, []);

  const find = useCallback(async () => {
    const q = query.trim();
    setFindError(null);
    setNotice(null);
    if (!q) { setFindError('Enter a @handle or a user id.'); return; }
    if (isUuid(q)) {
      setTarget({ id: q, label: q });
      void load(q);
      return;
    }
    setFinding(true);
    const r = await lookupUser({ handle: q.replace(/^@/, '') });
    setFinding(false);
    if (!r.ok) { setFindError(r.error); return; }
    const p = r.data.profile;
    setTarget({ id: p.id, label: p.handle ? `@${p.handle}` : p.display_name ?? p.id });
    void load(p.id);
  }, [query, load]);

  const run = useCallback(async <T,>(key: string, fn: () => Promise<AdminApiResult<T>>, done: (data: T) => string) => {
    if (!target) return;
    if (!reason.trim()) { setActionError('A reason is required for every stamp action.'); return; }
    setBusy(key);
    setActionError(null);
    setNotice(null);
    const r = await fn();
    setBusy(null);
    if (!r.ok) { setActionError(r.error); return; }
    const message = done(r.data);
    if (message.startsWith('!')) setActionError(message.slice(1)); else setNotice(message);
    void load(target.id);
  }, [target, reason, load]);

  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="User stamps" subtitle="Award, revoke and restore a person's stamps" />
      <KeyboardSafeView contentContainerStyle={a.body}>
        <View style={a.card}>
          <Text style={a.label}>Person (@handle or user id)</Text>
          <TextInput style={a.input} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
            onSubmitEditing={() => void find()} accessibilityLabel="Handle or user id" testID="stamps-query" />
          <View style={a.row}>
            <AdminButton label={finding ? 'Finding…' : 'Find'} tone="primary" disabled={finding} onPress={() => void find()} testID="stamps-find" />
          </View>
          {!!findError && <Text style={a.formError} accessibilityRole="alert" testID="stamps-find-error">{findError}</Text>}
        </View>

        {!!target && (
          <>
            <Text style={a.sectionTitle}>{target.label}</Text>
            <View style={a.card}>
              <Text style={a.label}>Reason (recorded with every action)</Text>
              <TextInput style={a.input} value={reason} onChangeText={setReason} maxLength={500} accessibilityLabel="Reason" testID="stamps-reason" />
              <Text style={a.label}>Award a stamp by definition slug</Text>
              <TextInput style={a.input} value={slug} onChangeText={setSlug} autoCapitalize="none" placeholder="e.g. hidden_gem_explorer" accessibilityLabel="Definition slug" testID="stamps-slug" />
              <View style={a.row}>
                <AdminButton label="Award" tone="primary" disabled={busy === 'award' || !slug.trim()} testID="stamps-award"
                  onPress={() => void run('award', () => awardStamp(target.id, slug, reason),
                    (d) => (d.awarded ? `Awarded ${slug.trim()}.` : `!Not awarded: ${String(d.reason).replace(/_/g, ' ')}.`))} />
              </View>
              {!!notice && <Text style={a.notice} accessibilityLiveRegion="polite" testID="stamps-notice">{notice}</Text>}
              {!!actionError && <Text style={a.formError} accessibilityRole="alert" testID="stamps-action-error">{actionError}</Text>}
            </View>

            {data.state === 'loading' && <AdminLoading testID="stamps-loading" />}
            {data.state === 'error' && (
              <AdminError message={`Couldn't load their stamps: ${data.message}`} onRetry={() => void load(target.id)} testID="stamps-error" />
            )}
            {data.state === 'ready' && data.rows.length === 0 && <AdminEmpty message="This person holds no stamps." testID="stamps-empty" />}
            {data.state === 'ready' && data.rows.length > 0 && (
              <Text style={a.meta}>{data.total > data.rows.length ? `Newest ${data.rows.length} of ${data.total}` : `${data.total} stamp${data.total === 1 ? '' : 's'}`}</Text>
            )}
            {data.state === 'ready' && data.rows.map((st) => (
              <View key={st.id} style={a.card} testID={`stamp-${st.id}`}>
                <Text style={a.cardTitle}>{st.stamp_definitions?.name ?? st.stamp_definitions?.slug ?? 'Unknown stamp'}{st.is_revoked ? ' — revoked' : ''}</Text>
                <Text style={a.meta}>{[st.stamp_definitions?.stamp_type, [st.city, st.country].filter(Boolean).join(', '), new Date(st.earned_at).toLocaleDateString()].filter(Boolean).join(' · ')}</Text>
                {st.is_revoked && !!st.revoked_reason && <Text style={a.meta}>Revoked: {st.revoked_reason}</Text>}
                <Text style={a.mono} selectable>{st.id}</Text>
                <View style={a.row}>
                  {st.is_revoked ? (
                    <AdminButton label="Restore" disabled={busy === st.id} testID={`stamp-restore-${st.id}`}
                      onPress={() => void run(st.id, () => restoreUserStamp(st.id, reason), () => 'Restored.')} />
                  ) : (
                    <AdminButton label="Revoke" tone="danger" disabled={busy === st.id} testID={`stamp-revoke-${st.id}`}
                      onPress={() => void run(st.id, () => revokeUserStamp(st.id, reason), () => 'Revoked.')} />
                  )}
                </View>
              </View>
            ))}
          </>
        )}
      </KeyboardSafeView>
    </View>
  );
}
