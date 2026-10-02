/**
 * Rent a Buddy — Admin review moderation (testing mode, lane tm-rab, PLAT-F49).
 *
 * Every buddy review is written `pending_moderation` and only becomes public
 * when an admin approves it (docs/rent-buddy-product.md "Moderation"), but the
 * moderation routes had no screen, so no review could ever reach a profile
 * from the app. This is that queue: list by moderation status, approve (the
 * server recalculates the buddy's rating) or reject with a reason.
 *
 * A failed read is an error with retry, never an empty queue (the server now
 * answers 5xx on a failed read); a failed approve/reject is reported, never
 * shown as done (the server now checks its write).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert, RefreshControl, ActivityIndicator } from 'react-native';
import { Star, Check, X } from 'lucide-react-native';
import { color } from '../../../src/theme/tokens';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import {
  listAdminReviews, approveReview, rejectReview,
  type AdminReview, type ReviewModerationStatus,
} from '../../../src/services/rentABuddyAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';
import { RabAdminScaffold, adminListState, adminCard as c } from '../../../src/components/rentabuddy/RabAdminScaffold';

const TABS: ReadonlyArray<{ key: ReviewModerationStatus; label: string }> = [
  { key: 'pending_moderation', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const REJECT_REASONS = ['Spam or fake', 'Abusive or hateful', 'Off-platform payment or contact details', 'Not about this booking'];

export default function AdminReviews() {
  useRequireAdmin();
  const [tab, setTab] = useState<ReviewModerationStatus>('pending_moderation');
  const [rows, setRows] = useState<AdminReview[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const lock = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await listAdminReviews(tab);
    if (!silent) setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setRows(res.data.reviews);
    setTotal(res.data.total);
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (id: string, call: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    if (lock.current) return;
    lock.current = true;
    setActing(id);
    try {
      const r = await call();
      if (!r.ok) { Alert.alert("That didn't save", bookingErrorCopy(r.error, 'Please try again.')); return; }
      Alert.alert(done);
      await load(true);
    } finally {
      lock.current = false;
      setActing(null);
    }
  }, [load]);

  const state = adminListState({
    loading, error, count: rows.length, onRetry: () => { void load(); },
    loadingLabel: 'Loading reviews…',
    emptyTitle: tab === 'pending_moderation' ? 'Nothing waiting for moderation' : 'No reviews here',
    emptySub: tab === 'pending_moderation' ? 'New buddy reviews appear here until an admin approves or rejects them.' : 'Reviews move here once moderated.',
  });

  return (
    <RabAdminScaffold
      title="Review moderation"
      subtitle={!loading && !error ? `${total} ${tab === 'pending_moderation' ? 'waiting' : 'in this list'}` : undefined}
      tabs={TABS}
      activeTab={tab}
      onTab={(k) => setTab(k as ReviewModerationStatus)}
    >
      {state ?? (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={c.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />}
          renderItem={({ item }) => (
            <View style={c.card} testID={`review-${item.id}`}>
              <View style={c.row}>
                <Star size={14} color={color.warn} fill={color.warn} />
                <Text style={c.title}>{item.rating} / 5 · {item.role === 'traveler' ? 'Traveller reviewing buddy' : 'Buddy reviewing traveller'}</Text>
              </View>
              {item.body ? <Text style={c.body}>{item.body}</Text> : <Text style={c.meta}>(No written review)</Text>}
              <Text style={c.meta}>
                Safety {item.safety_score ?? '–'} · Communication {item.communication_score ?? '–'} · Punctuality {item.punctuality_score ?? '–'}
              </Text>
              <Text style={c.meta}>Booking {item.booking_id.slice(0, 8)} · {new Date(item.created_at).toLocaleString()}</Text>
              {tab === 'pending_moderation' ? (
                <View style={c.actions}>
                  <Pressable
                    style={[c.btn, c.btnPrimary]}
                    disabled={acting !== null}
                    testID={`review-approve-${item.id}`}
                    onPress={() => { void act(item.id, () => approveReview(item.id), 'Approved — the review is public and the rating is recalculated.'); }}
                  >
                    {acting === item.id ? <ActivityIndicator color={color.onInk} /> : <Check size={15} color={color.onInk} />}
                    <Text style={c.btnTextPrimary}>Approve</Text>
                  </Pressable>
                  <Pressable
                    style={[c.btn, c.btnDanger]}
                    disabled={acting !== null}
                    testID={`review-reject-${item.id}`}
                    onPress={() => Alert.alert('Reject this review?', 'Pick the reason. It is kept in the admin log.', [
                      ...REJECT_REASONS.map((reason) => ({
                        text: reason,
                        onPress: () => { void act(item.id, () => rejectReview(item.id, reason), 'Rejected — the review stays hidden.'); },
                      })),
                      { text: 'Cancel', style: 'cancel' as const },
                    ])}
                  >
                    <X size={15} color={color.signal} />
                    <Text style={c.btnTextDanger}>Reject</Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={c.pill}>{item.moderation_status === 'approved' ? 'Public' : 'Hidden'}</Text>
              )}
            </View>
          )}
        />
      )}
    </RabAdminScaffold>
  );
}
