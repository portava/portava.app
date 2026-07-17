import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { fetchGamingFlags, markGamingFlagReviewed, type TrustReview } from '../../src/services/trustAdmin';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';

const PATTERN_LABELS: Record<string, string> = {
  rapid_jump:      '📈 Rapid Score Jump',
  checkin_cluster: '📍 Check-in Cluster',
  mutual_upvote:   '🔄 Mutual Upvote Ring',
};

function FlagRow({
  item,
  onView,
  onDismiss,
}: {
  item: TrustReview;
  onView: () => void;
  onDismiss: () => void;
}) {
  const pattern = (item.metadata as any)?.pattern as string | undefined;
  const label   = pattern ? (PATTERN_LABELS[pattern] ?? pattern) : 'Suspected Gaming';
  const count   = (item.metadata as any)?.count;

  return (
    <Pressable style={styles.row} onPress={onView} android_ripple={{ color: '#E5E7EB' }}>
      <View style={styles.rowTop}>
        <Text style={styles.patternLabel}>{label}</Text>
        {count !== undefined && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>×{count}</Text>
          </View>
        )}
      </View>
      <Text style={styles.userId} numberOfLines={1}>{item.user_id}</Text>
      <Text style={styles.date}>{new Date(item.created_at).toLocaleDateString()}</Text>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.viewBtn} onPress={onView}>
          <Text style={styles.viewBtnText}>View User</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.dismissBtn} onPress={onDismiss}>
          <Text style={styles.dismissBtnText}>Mark Reviewed</Text>
        </TouchableOpacity>
      </View>
    </Pressable>
  );
}

export default function GamingFlagsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();
  const [flags, setFlags]           = useState<TrustReview[]>([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionLoading && !isAuthed) { router.replace('/(auth)/sign-in' as any); }
  }, [isAuthed, sessionLoading]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchGamingFlags(100);
      setFlags(data.flags);
      setTotal(data.total);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load gaming flags');
    }
  }, []);

  useEffect(() => {
    if (sessionLoading || !isAuthed) return;
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load, isAuthed, sessionLoading]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Cross-platform note prompt (Alert.prompt is iOS-only — a silent no-op on
  // Android/web), backed by a modal with a TextInput.
  const [reviewTarget, setReviewTarget] = useState<TrustReview | null>(null);

  const onDismiss = (item: TrustReview) => setReviewTarget(item);

  const submitReview = async (notes: string) => {
    const item = reviewTarget;
    if (!item) return;
    setReviewTarget(null);
    setDismissingId(item.id);
    try {
      await markGamingFlagReviewed(item.id, notes || undefined);
      setFlags((prev) => prev.filter((f) => f.id !== item.id));
      setTotal((t) => t - 1);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not mark as reviewed');
    } finally {
      setDismissingId(null);
    }
  };

  const onView = (item: TrustReview) => {
    router.push({ pathname: '/admin/trust-detail' as any, params: { userId: item.user_id } });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color="#111827" />
        </Pressable>
        <Text style={styles.title}>Gaming Flags</Text>
        <Text style={styles.subtitle}>{total} suspected account{total !== 1 ? 's' : ''}</Text>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#EF4444" />
        </View>
      ) : error ? (
        <View style={styles.centered} testID="gaming-flags-error" accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : flags.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🎉</Text>
          <Text style={styles.emptyText}>No active gaming flags</Text>
        </View>
      ) : (
        <FlatList
          data={flags}
          keyExtractor={(f) => f.id}
          renderItem={({ item }) => (
            <FlagRow
              item={item}
              onView={() => onView(item)}
              onDismiss={() => onDismiss(item)}
            />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}

      <ReasonPromptModal
        visible={reviewTarget != null}
        title="Mark as Reviewed"
        message="Add an optional note for this decision:"
        placeholder="Optional note"
        confirmLabel="Mark Reviewed"
        requireValue={false}
        onCancel={() => setReviewTarget(null)}
        onSubmit={submitReview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  header:    { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 12 },
  backBtn:   { padding: 4, marginBottom: 6 },
  title:     { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle:  { fontSize: 13, color: '#6B7280', marginTop: 2 },

  row:        { backgroundColor: '#fff', padding: 16, margin: 1 },
  rowTop:     { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  patternLabel: { fontSize: 15, fontWeight: '600', color: '#111827', flex: 1 },
  countBadge: { backgroundColor: '#FEE2E2', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  countText:  { fontSize: 12, color: '#EF4444', fontWeight: '700' },
  userId:     { fontSize: 12, color: '#6B7280' },
  date:       { fontSize: 11, color: '#9CA3AF', marginTop: 2 },

  actions:       { flexDirection: 'row', marginTop: 10, gap: 8 },
  viewBtn:       { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#3B82F6', alignItems: 'center' },
  viewBtnText:   { fontSize: 13, color: '#3B82F6', fontWeight: '600' },
  dismissBtn:    { flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: '#F3F4F6', alignItems: 'center' },
  dismissBtnText:{ fontSize: 13, color: '#374151', fontWeight: '600' },

  sep:       { height: 1, backgroundColor: '#F3F4F6' },
  centered:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:  { backgroundColor: '#3B82F6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: '#fff', fontWeight: '600' },
  emptyIcon: { fontSize: 40, marginBottom: 8 },
  emptyText: { color: '#9CA3AF', fontSize: 15 },
});
