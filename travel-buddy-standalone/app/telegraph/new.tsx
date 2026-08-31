/**
 * New Telegraph — recipient picker for STARTING a new conversation.
 *
 * The client audit flagged that "Start Telegraph" merely routed to `/discover`
 * with no way to pick a recipient and open a fresh 1:1 thread. This screen is
 * that missing picker (§5 `telegraph_recipient`, §13/§14). It is backed by the
 * P1 gateway through `useTelegraphRecipients` (recent conversations / Trip Crew
 * / followed / eligible — block- and privacy-filtered SERVER-SIDE, §29/§47), so
 * the list here is never re-filtered around the backend.
 *
 * DEGRADE GRACEFULLY (§38): the recipient-search endpoint ships in a parallel
 * backend PR. When it is absent (404/offline → `unavailable`) this screen falls
 * back to the previous behavior — a shortcut into Discover to find people — and
 * never throws.
 *
 * Selecting a recipient funnels through `openDirectThread` (the one 1:1 funnel,
 * which also negotiates E2EE for new threads) and routes into the thread, exactly
 * like every other "Message" entry point. On failure it falls back to the
 * recipient's profile, where the permission-gated Message button lives.
 */
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { Search, X, Users, Zap } from 'lucide-react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { CachedImage } from '../../src/components/CachedImage';
import { PlainBottomFiller } from '../../src/hooks/useBottomInset';
import { useTelegraphRecipients } from '../../src/hooks/useTelegraphRecipients';
import type { RecipientRow } from '../../src/platform/input-assistance/social/telegraphRecipients';
import { openDirectThread } from '../../src/services/messaging';
import { fallbackInitials } from '../../src/utils/identity';
import { color, space, radius, type as t, avatar } from '../../src/theme/tokens';

export default function NewTelegraphScreen() {
  const [query, setQuery] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);

  const { recipients, loading, unavailable } = useTelegraphRecipients(query, {
    surface: 'telegraph_new',
  });

  const goToDiscover = useCallback(() => {
    // The pre-existing behavior: find people via Discover. Used as the graceful
    // fallback when recipient search is unavailable, and never throws.
    router.replace('/discover' as any);
  }, []);

  const startConversation = useCallback(
    async (r: RecipientRow) => {
      if (openingId) return;
      setOpeningId(r.userId);
      const res = await openDirectThread(r.userId);
      setOpeningId(null);
      if (res.ok && res.data?.threadId) {
        router.replace(
          `/messages/${res.data.threadId}?threadType=direct&otherUserId=${encodeURIComponent(r.userId)}` as any,
        );
        return;
      }
      // Could not open directly (e.g. requires a message request) — fall back to
      // the recipient's profile, which carries the permission-gated Message flow.
      const profileKey = r.handle ?? r.userId;
      router.push(`/u/${profileKey}` as any);
    },
    [openingId],
  );

  const trimmed = query.trim();
  const showFallback = unavailable && recipients.length === 0;
  const showEmpty = !loading && !unavailable && recipients.length === 0 && trimmed.length > 0;
  const showIdle =
    !loading && !unavailable && recipients.length === 0 && trimmed.length === 0;

  return (
    <View style={styles.root}>
      <AppHeader variant="detail" title="New Telegraph" onBack={router.back} />

      <KeyboardSafeScrollView>
        <View style={styles.searchRow}>
          <Search size={16} color={color.faint} style={styles.searchIcon} />
          <TextInput
            style={styles.input}
            placeholder="Search people to message"
            placeholderTextColor={color.faint}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="search"
            testID="new-telegraph-search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} style={styles.clearBtn} hitSlop={8}>
              <X size={15} color={color.mute} />
            </Pressable>
          )}
        </View>

        {loading && recipients.length === 0 && (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={color.signal} />
          </View>
        )}

        {recipients.length > 0 && (
          <View style={styles.list}>
            <Text style={styles.sectionHeader}>
              {trimmed.length > 0 ? 'People' : 'Recent & suggested'}
            </Text>
            {recipients.map((r) => (
              <RecipientRowView
                key={r.userId}
                recipient={r}
                opening={openingId === r.userId}
                disabled={openingId != null}
                onPress={() => startConversation(r)}
              />
            ))}
          </View>
        )}

        {/* Graceful degrade: recipient search unavailable → route into Discover. */}
        {showFallback && (
          <EmptyState
            icon={Users}
            title="Find someone to message"
            description="Search for travelers, then open their profile to start a Telegraph."
            primaryAction={{ label: 'Find people', onPress: goToDiscover }}
          />
        )}

        {showEmpty && (
          <EmptyState
            icon={Zap}
            title="No matches"
            description="Try a different name or @username."
          />
        )}

        {showIdle && (
          <EmptyState
            icon={Zap}
            title="Start a new Telegraph"
            description="Search for someone by name or @username to begin a conversation."
          />
        )}

        <PlainBottomFiller />
      </KeyboardSafeScrollView>
    </View>
  );
}

function RecipientRowView({
  recipient,
  opening,
  disabled,
  onPress,
}: {
  recipient: RecipientRow;
  opening: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && !opening && styles.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Message ${recipient.name}`}
    >
      <View style={styles.avatarWrap}>
        {recipient.avatarUrl ? (
          <CachedImage source={{ uri: recipient.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarInitials}>
              {fallbackInitials({ name: recipient.name, handle: recipient.handle ?? undefined })}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>{recipient.name}</Text>
        {(recipient.reason ?? recipient.subtitle) && (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {recipient.reason ?? recipient.subtitle}
          </Text>
        )}
      </View>
      {opening && <ActivityIndicator size="small" color={color.signal} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.lg,
    marginVertical: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    height: 44,
  },
  searchIcon: { marginRight: space.sm },
  input: {
    flex: 1,
    fontSize: 15,
    color: color.ink,
    height: '100%',
  },
  clearBtn: { padding: 4, marginLeft: space.sm },
  loadingRow: {
    paddingVertical: space.xl,
    alignItems: 'center',
  },
  list: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.xs,
  },
  sectionHeader: {
    ...t.small,
    color: color.mute,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  rowPressed: { backgroundColor: color.paperRaised },
  rowDisabled: { opacity: 0.5 },
  avatarWrap: {},
  avatar: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: color.haze,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    ...t.small,
    color: color.mute,
    fontWeight: '700',
  },
  rowText: { flex: 1 },
  rowName: {
    ...t.body,
    color: color.ink,
    fontWeight: '600',
  },
  rowSubtitle: {
    ...t.small,
    color: color.mute,
    marginTop: 1,
  },
});
