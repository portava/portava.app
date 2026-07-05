import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Pressable, ActivityIndicator,
  StyleSheet, Image, Alert, ScrollView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapPin, Calendar, X, CheckCircle2, Plane, AlertTriangle } from 'lucide-react-native';
import { useSession } from '../../src/context/SessionContext';
import {
  previewInviteLink, acceptInviteByToken,
  type InvitePreview,
} from '../../src/services/trips';
import {
  mapInvitePreviewToScreenState,
  type ScreenState,
} from '../../src/lib/invitePreviewMapper';
import { color, space, radius, type as t } from '../../src/theme/tokens';

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return '';
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return end ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
}

export default function InviteLinkScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const insets = useSafeAreaInsets();
  const { configured, isAuthed } = useSession();
  const [screen, setScreen] = useState<ScreenState>({ kind: 'loading' });
  const [joining, setJoining] = useState(false);

  const load = useCallback(async () => {
    if (!configured) return;
    if (!isAuthed) { setScreen({ kind: 'not_authed' }); return; }
    if (!token) { setScreen({ kind: 'gone', message: 'Invalid invite link.' }); return; }
    setScreen({ kind: 'loading' });
    const result = await previewInviteLink(token);
    setScreen(mapInvitePreviewToScreenState(result));
  }, [configured, isAuthed, token]);

  useEffect(() => { load(); }, [load]);

  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  async function handleAccept(preview: InvitePreview) {
    if (joining || !token) return;
    setJoining(true);
    const result = await acceptInviteByToken(token);
    setJoining(false);
    if (result.tripId) {
      router.replace(`/trip/${result.tripId}` as Parameters<typeof router.replace>[0]);
    } else if (result.alreadyMember) {
      router.replace(`/trip/${preview.tripId}` as Parameters<typeof router.replace>[0]);
    } else if (result.error === 'gone' && result.reason === 'trip_full') {
      // Trip filled up between preview and accept — re-fetch so the screen
      // transitions to the 'full' state instead of showing a generic error.
      load();
    } else {
      const msg =
        result.error === 'gone'
          ? 'This trip is no longer accepting new members.'
          : result.error === 'not_authenticated'
          ? 'Please sign in and try again.'
          : 'The invite link may have expired. Please ask the trip owner for a new one.';
      Alert.alert('Could not join', msg);
    }
  }

  const pt = insets.top + space.sm;
  const pb = insets.bottom + space.xl;

  return (
    <View style={[styles.root, { paddingTop: pt, paddingBottom: pb }]}>
      <Pressable style={styles.closeBtn} hitSlop={12} onPress={handleClose}>
        <X size={20} color={color.ink} />
      </Pressable>

      {screen.kind === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={color.signal} />
          <Text style={styles.hint}>Loading invite…</Text>
        </View>
      )}

      {screen.kind === 'not_authed' && (
        <View style={styles.center}>
          <Plane size={44} color={color.deep} />
          <Text style={styles.heading}>Sign in to join</Text>
          <Text style={styles.bodyText}>
            You need a Travel Buddy account to accept this invite.
          </Text>
          <Pressable
            style={styles.primaryBtn}
            onPress={() => router.replace('/(auth)/sign-in' as Parameters<typeof router.replace>[0])}
          >
            <Text style={styles.primaryBtnText}>Sign in</Text>
          </Pressable>
        </View>
      )}

      {screen.kind === 'gone' && (
        <View style={styles.center}>
          <Text style={styles.heading}>Link unavailable</Text>
          <Text style={styles.bodyText}>{screen.message}</Text>
          <Pressable style={styles.ghostBtn} onPress={handleClose}>
            <Text style={styles.ghostBtnText}>Go back</Text>
          </Pressable>
        </View>
      )}

      {screen.kind === 'error' && (
        <View style={styles.center}>
          <Text style={styles.heading}>Something went wrong</Text>
          <Text style={styles.bodyText}>We couldn't load this invite. Try again.</Text>
          <Pressable style={styles.primaryBtn} onPress={load}>
            <Text style={styles.primaryBtnText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {screen.kind === 'already_member' && (
        <View style={styles.center}>
          <CheckCircle2 size={44} color={color.success} />
          <Text style={styles.heading}>You're already on this trip!</Text>
          <Pressable
            style={styles.primaryBtn}
            onPress={() =>
              router.replace(`/trip/${screen.tripId}` as Parameters<typeof router.replace>[0])
            }
          >
            <Text style={styles.primaryBtnText}>View Trip</Text>
          </Pressable>
        </View>
      )}

      {screen.kind === 'terminal' && (
        <ScrollView
          contentContainerStyle={styles.cardContent}
          showsVerticalScrollIndicator={false}
        >
          {screen.preview.coverUrl ? (
            <Image
              source={{ uri: screen.preview.coverUrl }}
              style={[styles.cover, styles.coverDimmed]}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.cover, styles.coverPlaceholder, styles.coverDimmed]}>
              <Plane size={36} color={color.mute} />
            </View>
          )}

          <View style={styles.warningBanner}>
            <AlertTriangle size={16} color={color.warn} />
            <Text style={styles.warningText}>{screen.message}</Text>
          </View>

          <View style={[styles.cardBody, styles.cardBodyDimmed]}>
            <Text style={styles.label}>YOU'VE BEEN INVITED TO</Text>
            <Text style={styles.tripTitle}>
              {screen.preview.tripTitle ?? screen.preview.destinationCity ?? 'a trip'}
            </Text>

            {Boolean(screen.preview.destinationCity) && (
              <View style={styles.metaRow}>
                <MapPin size={14} color={color.faint} />
                <Text style={styles.metaText}>
                  {[screen.preview.destinationCity, screen.preview.destinationCountry]
                    .filter(Boolean)
                    .join(', ')}
                </Text>
              </View>
            )}

            {Boolean(screen.preview.startDate) && (
              <View style={styles.metaRow}>
                <Calendar size={14} color={color.faint} />
                <Text style={styles.metaText}>
                  {formatDateRange(screen.preview.startDate, screen.preview.endDate)}
                </Text>
              </View>
            )}
          </View>

          <View style={[styles.primaryBtn, styles.primaryBtnFull, styles.btnDisabled]}>
            <Text style={styles.primaryBtnText}>Accept Invite</Text>
          </View>

          <Pressable style={styles.ghostBtn} onPress={handleClose}>
            <Text style={styles.ghostBtnText}>Go back</Text>
          </Pressable>
        </ScrollView>
      )}

      {screen.kind === 'full' && (
        <ScrollView
          contentContainerStyle={styles.cardContent}
          showsVerticalScrollIndicator={false}
        >
          {screen.preview.coverUrl ? (
            <Image
              source={{ uri: screen.preview.coverUrl }}
              style={[styles.cover, styles.coverDimmed]}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.cover, styles.coverPlaceholder, styles.coverDimmed]}>
              <Plane size={36} color={color.mute} />
            </View>
          )}

          <View style={styles.warningBanner}>
            <AlertTriangle size={16} color={color.warn} />
            <Text style={styles.warningText}>This trip is full.</Text>
          </View>

          <View style={[styles.cardBody, styles.cardBodyDimmed]}>
            <Text style={styles.label}>YOU'VE BEEN INVITED TO</Text>
            <Text style={styles.tripTitle}>
              {screen.preview.tripTitle ?? screen.preview.destinationCity ?? 'a trip'}
            </Text>

            {Boolean(screen.preview.destinationCity) && (
              <View style={styles.metaRow}>
                <MapPin size={14} color={color.faint} />
                <Text style={styles.metaText}>
                  {[screen.preview.destinationCity, screen.preview.destinationCountry]
                    .filter(Boolean)
                    .join(', ')}
                </Text>
              </View>
            )}

            {Boolean(screen.preview.startDate) && (
              <View style={styles.metaRow}>
                <Calendar size={14} color={color.faint} />
                <Text style={styles.metaText}>
                  {formatDateRange(screen.preview.startDate, screen.preview.endDate)}
                </Text>
              </View>
            )}
          </View>

          <View style={[styles.primaryBtn, styles.primaryBtnFull, styles.btnDisabled]}>
            <Text style={styles.primaryBtnText}>Accept Invite</Text>
          </View>

          <Pressable style={styles.ghostBtn} onPress={handleClose}>
            <Text style={styles.ghostBtnText}>Go back</Text>
          </Pressable>
        </ScrollView>
      )}

      {screen.kind === 'ready' && (
        <ScrollView
          contentContainerStyle={styles.cardContent}
          showsVerticalScrollIndicator={false}
        >
          {screen.preview.coverUrl ? (
            <Image
              source={{ uri: screen.preview.coverUrl }}
              style={styles.cover}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.cover, styles.coverPlaceholder]}>
              <Plane size={36} color={color.mute} />
            </View>
          )}

          <View style={styles.cardBody}>
            <Text style={styles.label}>YOU'VE BEEN INVITED TO</Text>
            <Text style={styles.tripTitle}>
              {screen.preview.tripTitle ?? screen.preview.destinationCity ?? 'a trip'}
            </Text>

            {Boolean(screen.preview.destinationCity) && (
              <View style={styles.metaRow}>
                <MapPin size={14} color={color.mute} />
                <Text style={styles.metaText}>
                  {[screen.preview.destinationCity, screen.preview.destinationCountry]
                    .filter(Boolean)
                    .join(', ')}
                </Text>
              </View>
            )}

            {Boolean(screen.preview.startDate) && (
              <View style={styles.metaRow}>
                <Calendar size={14} color={color.mute} />
                <Text style={styles.metaText}>
                  {formatDateRange(screen.preview.startDate, screen.preview.endDate)}
                </Text>
              </View>
            )}
          </View>

          <Pressable
            style={[styles.primaryBtn, styles.primaryBtnFull, joining && styles.btnDisabled]}
            disabled={joining}
            onPress={() => handleAccept(screen.preview)}
          >
            {joining
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <Text style={styles.primaryBtnText}>Accept Invite</Text>}
          </Pressable>

          <Pressable style={styles.ghostBtn} onPress={handleClose}>
            <Text style={styles.ghostBtnText}>Not now</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
    paddingHorizontal: space.xl,
  },
  closeBtn: {
    alignSelf: 'flex-end',
    padding: space.sm,
    marginBottom: space.sm,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
  },
  heading: {
    ...(t.title as object),
    color: color.ink,
    textAlign: 'center',
  },
  bodyText: {
    ...(t.body as object),
    color: color.mute,
    textAlign: 'center',
  },
  hint: {
    ...(t.small as object),
    color: color.mute,
    marginTop: space.sm,
  },
  cardContent: {
    gap: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  cover: {
    width: '100%',
    height: 200,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  coverPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    gap: space.sm,
  },
  label: {
    ...(t.stamp as object),
    color: color.faint,
    letterSpacing: 1,
  },
  tripTitle: {
    ...(t.title as object),
    color: color.ink,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  metaText: {
    ...(t.body as object),
    color: color.mute,
  },
  primaryBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    alignSelf: 'center',
    minWidth: 200,
  },
  primaryBtnFull: {
    alignSelf: 'stretch',
  },
  primaryBtnText: {
    ...(t.bodyStrong as object),
    color: color.onInk,
  },
  ghostBtn: {
    paddingVertical: space.md,
    alignItems: 'center',
    alignSelf: 'center',
  },
  ghostBtnText: {
    ...(t.body as object),
    color: color.mute,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  coverDimmed: {
    opacity: 0.4,
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.haze,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  warningText: {
    ...(t.bodyStrong as object),
    color: color.warn,
    flex: 1,
  },
  cardBodyDimmed: {
    opacity: 0.5,
  },
});
