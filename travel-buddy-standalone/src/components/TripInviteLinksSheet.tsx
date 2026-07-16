/**
 * TripInviteLinksSheet
 *
 * Owner-only bottom sheet that lists all invite links created for a trip.
 * Each row shows:
 *   • Status badge (Active / Revoked / Expired / Exhausted)
 *   • Use count and optional max-uses cap
 *   • Avatars of everyone who joined via that link
 *   • Revoke button for active links (with confirmation)
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator,
  Image, Modal, Alert, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { X, Link2, Trash2, Users } from 'lucide-react-native';
import {
  getInviteLinks, revokeInviteLink,
  type InviteLinkUsage, type InviteLinkJoiner,
} from '../services/trips.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

interface Props {
  tripId: string;
  visible: boolean;
  onDismiss: () => void;
}

function Avatar({ user, size = 30, onPress }: { user: InviteLinkJoiner; size?: number; onPress?: () => void }) {
  const inner = user.avatarUrl ? (
    <Image
      source={{ uri: user.avatarUrl }}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.haze, opacity: user.removed ? 0.4 : 1 }}
    />
  ) : (
    <View style={[{ width: size, height: size, borderRadius: size / 2, opacity: user.removed ? 0.4 : 1 }, s.avatarFallback]}>
      <Text style={s.avatarInitial}>{(user.name?.[0] ?? user.handle?.[0] ?? '?').toUpperCase()}</Text>
    </View>
  );
  if (onPress) {
    return <Pressable onPress={onPress} hitSlop={4}>{inner}</Pressable>;
  }
  return inner;
}

type StatusKind = 'active' | 'revoked' | 'expired' | 'exhausted';

function statusOf(link: InviteLinkUsage): StatusKind {
  if (link.isRevoked) return 'revoked';
  if (link.isExpired) return 'expired';
  if (link.isExhausted) return 'exhausted';
  return 'active';
}

const STATUS_LABEL: Record<StatusKind, string> = {
  active:    'Active',
  revoked:   'Revoked',
  expired:   'Expired',
  exhausted: 'Limit reached',
};

const STATUS_COLOR: Record<StatusKind, string> = {
  active:    color.success,
  revoked:   color.faint,
  expired:   color.faint,
  exhausted: color.warn,
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function useCount(link: InviteLinkUsage): string {
  if (link.maxUses !== null) return `${link.useCount} / ${link.maxUses} accepted`;
  return `${link.useCount} accepted all-time`;
}

interface LinkRowProps {
  link: InviteLinkUsage;
  onRevoke: (link: InviteLinkUsage) => void;
  onPressJoiner: (joiner: InviteLinkJoiner) => void;
  revoking: boolean;
}

function LinkRow({ link, onRevoke, onPressJoiner, revoking }: LinkRowProps) {
  const status = statusOf(link);
  const visible = link.joiners.slice(0, 5);
  const overflow = link.joiners.length - visible.length;

  return (
    <View style={s.linkCard}>
      <View style={s.linkHeader}>
        <Link2 size={14} color={color.mute} />
        <Text style={s.linkToken} numberOfLines={1}>
          {link.token.slice(0, 8)}…
        </Text>
        <View style={[s.badge, { backgroundColor: STATUS_COLOR[status] + '22' }]}>
          <Text style={[s.badgeText, { color: STATUS_COLOR[status] }]}>
            {STATUS_LABEL[status]}
          </Text>
        </View>
        {status === 'active' && (
          <Pressable
            style={s.revokeBtn}
            hitSlop={8}
            disabled={revoking}
            onPress={() => onRevoke(link)}
          >
            {revoking
              ? <ActivityIndicator size={12} color={color.signal} />
              : <Trash2 size={14} color={color.signal} />}
          </Pressable>
        )}
      </View>

      <View style={s.linkMeta}>
        <Text style={s.metaText}>{useCount(link)}</Text>
        <Text style={s.metaDot}>·</Text>
        <Text style={s.metaText}>Created {formatDate(link.createdAt)}</Text>
        {link.expiresAt && (
          <>
            <Text style={s.metaDot}>·</Text>
            <Text style={s.metaText}>
              {status === 'expired' ? 'Expired' : 'Expires'} {formatDate(link.expiresAt)}
            </Text>
          </>
        )}
      </View>

      {link.joiners.length > 0 ? (
        <View style={s.joinersRow}>
          <Users size={13} color={color.faint} />
          <View style={s.avatarStack}>
            {visible.map((j, i) => (
              <View key={j.id} style={[s.avatarStackItem, { zIndex: visible.length - i, marginLeft: i === 0 ? 0 : -8 }]}>
                <Avatar
                  user={j}
                  size={26}
                  onPress={j.handle ? () => onPressJoiner(j) : undefined}
                />
              </View>
            ))}
          </View>
          <View style={s.joinersLabelWrap}>
            {visible.map((j, i) => (
              <React.Fragment key={j.id}>
                {i > 0 && <Text style={s.joinersLabel}>, </Text>}
                <Pressable
                  onPress={j.handle ? () => onPressJoiner(j) : undefined}
                  disabled={!j.handle}
                >
                  <Text style={[s.joinersLabel, j.handle ? s.joinersLabelTappable : null, j.removed ? s.joinersLabelRemoved : null]}>
                    {j.name ?? j.handle ?? 'Someone'}
                  </Text>
                </Pressable>
                {j.removed && (
                  <View style={s.removedBadge}>
                    <Text style={s.removedBadgeText}>Removed</Text>
                  </View>
                )}
              </React.Fragment>
            ))}
            {overflow > 0 && <Text style={s.joinersLabel}> +{overflow} more</Text>}
          </View>
        </View>
      ) : (
        <Text style={s.noJoinersText}>No one has joined via this link yet.</Text>
      )}
    </View>
  );
}

export function TripInviteLinksSheet({ tripId, visible, onDismiss }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [links, setLinks] = useState<InviteLinkUsage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const data = await getInviteLinks(tripId);
    setLoading(false);
    if (!Array.isArray(data)) {
      setLoadError('Could not load invite links. Tap to retry.');
      return;
    }
    setLinks(data);
  }, [tripId]);

  useEffect(() => {
    if (visible) {
      load();
    } else {
      setLinks([]);
      setLoadError(null);
      setRevokingId(null);
    }
  }, [visible, load]);

  function handlePressJoiner(joiner: InviteLinkJoiner) {
    if (joiner.handle) {
      router.push(`/profile/${joiner.handle}` as any);
    }
  }

  function handleRevoke(link: InviteLinkUsage) {
    Alert.alert(
      'Revoke invite link?',
      'Anyone who hasn\'t joined yet won\'t be able to use this link. People who already joined will stay on the trip.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            setRevokingId(link.id);
            const ok = await revokeInviteLink(tripId, link.id);
            setRevokingId(null);
            if (ok) {
              setLinks((prev) =>
                prev.map((l) =>
                  l.id === link.id
                    ? { ...l, isActive: false, isRevoked: true, revokedAt: new Date().toISOString() }
                    : l,
                ),
              );
            } else {
              Alert.alert('Could not revoke', 'Something went wrong. Please try again.');
            }
          },
        },
      ],
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onDismiss}>
      <View style={s.root}>
        <View style={s.header}>
          <Text style={s.title}>Invite Links</Text>
          <Pressable hitSlop={10} onPress={onDismiss} style={s.closeBtn}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        {loading && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={color.signal} />
          </View>
        )}

        {!loading && loadError && (
          <Pressable style={s.center} onPress={load}>
            <Text style={s.errorText}>{loadError}</Text>
          </Pressable>
        )}

        {!loading && !loadError && links.length === 0 && (
          <View style={s.center}>
            <Link2 size={36} color={color.haze} />
            <Text style={s.emptyTitle}>No invite links yet</Text>
            <Text style={s.emptyBody}>
              Tap "Share Trip" on the trip page to create an invite link.
            </Text>
          </View>
        )}

        {!loading && !loadError && links.length > 0 && (
          <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            <Text style={s.subtitle}>
              {links.filter((l) => l.isActive).length} active ·{' '}
              {links.length} total
            </Text>
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                onRevoke={handleRevoke}
                onPressJoiner={handlePressJoiner}
                revoking={revokingId === link.id}
              />
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    ...(t.heading as object),
    color: color.ink,
  },
  closeBtn: {
    padding: space.xs,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
  },
  errorText: {
    ...(t.body as object),
    color: color.signal,
    textAlign: 'center',
  },
  emptyTitle: {
    ...(t.heading as object),
    color: color.ink,
    textAlign: 'center',
  },
  emptyBody: {
    ...(t.body as object),
    color: color.mute,
    textAlign: 'center',
  },
  subtitle: {
    ...(t.small as object),
    color: color.faint,
    marginBottom: space.sm,
  },
  list: {
    padding: space.xl,
    gap: space.md,
  },
  linkCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.haze,
  },
  linkHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  linkToken: {
    ...(t.small as object),
    color: color.mute,
    fontFamily: 'Courier',
    flex: 1,
  },
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  badgeText: {
    ...(t.stamp as object),
  },
  revokeBtn: {
    padding: space.xs,
  },
  linkMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  metaText: {
    ...(t.small as object),
    color: color.mute,
  },
  metaDot: {
    ...(t.small as object),
    color: color.faint,
  },
  joinersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
  },
  avatarStack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarStackItem: {
    borderWidth: 2,
    borderColor: color.paperRaised,
    borderRadius: 999,
  },
  joinersLabelWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    flex: 1,
  },
  joinersLabel: {
    ...(t.small as object),
    color: color.mute,
  },
  joinersLabelTappable: {
    color: color.ink,
    textDecorationLine: 'underline' as const,
  },
  joinersLabelRemoved: {
    color: color.faint,
    textDecorationLine: 'line-through' as const,
  },
  removedBadge: {
    backgroundColor: color.signal + '18',
    borderRadius: radius.pill,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 3,
  },
  removedBadgeText: {
    ...(t.stamp as object),
    color: color.signal,
  },
  noJoinersText: {
    ...(t.small as object),
    color: color.faint,
    fontStyle: 'italic',
    marginTop: space.xs,
  },
  avatarFallback: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    ...(t.small as object),
    fontWeight: '700',
    color: color.mute,
  },
});
