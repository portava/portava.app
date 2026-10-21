/**
 * LayoverMutualDiscoveryCard — §14 "L2 mutual discovery — profiles visible under policy" (census-layover L130).
 *
 * Owner decision 2026-10-18 (§7): "Both parties must explicitly opt in before the corresponding mutual-discovery
 * behavior is enabled." So this card is the whole consent surface, and it says exactly what each step does:
 *   - ask ONE traveller, by handle, to see each other on this layover (your opt-in);
 *   - accept or decline a request made to you (theirs was the first opt-in, yours is the second);
 *   - see the travellers you BOTH agreed to, each with "Stop seeing each other" (either of you, at once).
 *
 * A SIBLING of `LayoverPeopleSection` (its own read must not join that section's fetches). It draws nothing when the
 * server says mutual discovery is off. There is no "requests you sent" list, by design: the server never says whether
 * the person you named is here — you see them only if they accept — and this card repeats the server's words.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { UserCheck } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  answerDiscovery, endDiscovery, getDiscovery, requestDiscovery,
  type DiscoveryPerson, type DiscoveryRead,
} from '../../services/layoverDiscovery.ts';

interface Props { sessionId: string; refreshKey?: number }

const SHARING_REASON_TEXT: Record<string, string> = {
  sharing_off: 'Share your city on this layover to use mutual discovery — you can only see travellers who can see you.',
  sharing_gate_closed: 'Your location sharing is paused or off, so nobody sees you and you see nobody.',
  sharing_settings_unreadable: 'Your sharing settings could not be read, so nothing is shown.',
  session_ended: 'This layover has ended.',
};

function who(p: DiscoveryPerson): string { return p.name ?? (p.handle ? `@${p.handle}` : 'A traveller'); }

export function LayoverMutualDiscoveryCard({ sessionId, refreshKey = 0 }: Props) {
  const [read, setRead] = useState<DiscoveryRead | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ticket = useRef(0);
  /** The last ANSWERED read said the feature is on. A failed read before that draws nothing (as for feature off). */
  const known = useRef(false);

  const refresh = useCallback(async () => {
    const mine = ++ticket.current;
    const r = await getDiscovery(sessionId);
    if (mine !== ticket.current) return;
    if (r.ok) known.current = r.available;
    setRead(!r.ok && !known.current ? { ok: true, available: false } : r);
  }, [sessionId]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const run = useCallback(async (key: string, op: () => Promise<{ ok: boolean; message: string | null }>) => {
    setBusy(key); setNotice(null);
    const out = await op();
    setBusy(null);
    setNotice(out.message);
    await refresh();
  }, [refresh]);

  if (!read || (read.ok && !read.available)) return null;

  return (
    <View style={styles.card} testID="layover-mutual-discovery">
      <View style={styles.headerRow}>
        <UserCheck size={15} color={color.deep} />
        <Text style={styles.heading}>Travellers you agreed to see</Text>
      </View>
      {!read.ok ? (
        <Text style={styles.body} testID="layover-mutual-discovery-failed">{read.message}</Text>
      ) : !read.sharing ? (
        <Text style={styles.body} testID="layover-mutual-discovery-not-sharing">{SHARING_REASON_TEXT[read.reason] ?? SHARING_REASON_TEXT.sharing_off}</Text>
      ) : (
        <View style={{ gap: space.sm }}>
          <Text style={styles.sub}>Nobody is shown to you, and you are shown to nobody, until you BOTH agree. Either of you can stop at any time.</Text>

          {read.incoming.map((r) => (
            <View key={r.consentId} style={styles.row} testID={`layover-discovery-incoming-${r.consentId}`}>
              <Text style={[styles.body, { flex: 1 }]}>{who(r.from)} would like you to see each other on this layover.</Text>
              <Pressable onPress={() => { void run(`acc:${r.consentId}`, () => answerDiscovery(sessionId, r.consentId, true)); }} disabled={busy !== null} accessibilityRole="button" accessibilityLabel={`Agree to see ${who(r.from)}`} style={styles.primaryBtn}>
                <Text style={styles.primaryBtnText}>Agree</Text>
              </Pressable>
              <Pressable onPress={() => { void run(`dec:${r.consentId}`, () => answerDiscovery(sessionId, r.consentId, false)); }} disabled={busy !== null} accessibilityRole="button" accessibilityLabel={`Decline ${who(r.from)}`} style={styles.secondaryBtn}>
                <Text style={styles.secondaryBtnText}>Decline</Text>
              </Pressable>
            </View>
          ))}

          {read.mutual.length > 0 ? read.mutual.map((p) => (
            <View key={p.id} style={styles.row} testID={`layover-discovery-mutual-${p.id}`}>
              <Text style={[styles.bodyStrong, { flex: 1 }]}>{who(p)}</Text>
              {p.consentId ? (
                <Pressable onPress={() => { void run(`end:${p.consentId}`, () => endDiscovery(sessionId, p.consentId!)); }} disabled={busy !== null} accessibilityRole="button" accessibilityLabel={`Stop seeing ${who(p)}`} style={styles.secondaryBtn}>
                  <Text style={styles.secondaryBtnText}>Stop seeing each other</Text>
                </Pressable>
              ) : null}
            </View>
          )) : <Text style={styles.sub}>You have not agreed to see anyone here.</Text>}

          {read.degraded ? <Text style={styles.sub} testID="layover-mutual-discovery-degraded">Some of this could not be loaded, so it may be incomplete.</Text> : null}

          <View style={styles.row}>
            <TextInput value={handle} onChangeText={setHandle} placeholder="@handle" placeholderTextColor={color.faint} autoCapitalize="none" autoCorrect={false} maxLength={64} accessibilityLabel="Traveller's handle" style={styles.input} />
            <Pressable
              onPress={() => {
                const h = handle.trim();
                if (!h) { setNotice('Enter the traveller’s handle.'); return; }
                void run('ask', async () => { const out = await requestDiscovery(sessionId, h); if (out.ok) setHandle(''); return out; });
              }}
              disabled={busy !== null}
              accessibilityRole="button"
              accessibilityLabel="Ask to see each other"
              style={styles.primaryBtn}
            >
              {busy === 'ask' ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={styles.primaryBtnText}>Ask</Text>}
            </Pressable>
          </View>
        </View>
      )}
      {notice ? <Text style={styles.notice} testID="layover-mutual-discovery-notice">{notice}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  heading: { ...t.heading, color: color.ink },
  body: { ...t.small, color: color.ink },
  bodyStrong: { ...t.small, color: color.ink, fontWeight: '600' },
  sub: { ...t.small, color: color.mute, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingVertical: space.sm, paddingHorizontal: space.md, minHeight: 40, color: color.ink, ...t.small },
  primaryBtn: { backgroundColor: color.deep, borderRadius: radius.pill, paddingVertical: space.sm, paddingHorizontal: space.lg, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  secondaryBtn: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.sm, paddingHorizontal: space.md, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { ...t.small, color: color.deep, fontWeight: '600' },
  notice: { ...t.small, color: color.mute },
});
