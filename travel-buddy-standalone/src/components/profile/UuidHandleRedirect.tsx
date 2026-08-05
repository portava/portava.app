/**
 * UuidHandleRedirect — canonicalises profile routes that arrive with a raw
 * user id instead of a handle.
 *
 * /u/[username] and /passport/[username] are handle-addressed, but some
 * producers (saved profile collections, discovery rows for handle-less
 * accounts, older push payloads) still link with the profile's UUID. When the
 * incoming param is UUID-shaped, resolve the profile via GET /api/users/:id
 * and replace the route with the canonical handle URL so every downstream
 * fetch (passport, showcase, social) sees a handle, never a raw id.
 *
 * States: spinner while resolving; the standard profile not-found state when
 * the id does not resolve (unknown id, or an unavailable/blocked sentinel
 * that carries no handle).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { getProfileById } from '../../services/friends.ts';
import { color, space, type as t } from '../../theme/tokens.ts';
import { PROFILE_NOT_FOUND_TITLE, PROFILE_NOT_FOUND_SUB } from '../../constants/profileScreenCopy.ts';

/** Canonical 8-4-4-4-12 hex UUID (any version) — handles can never look like this. */
export const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidParam(param: string | string[] | undefined | null): param is string {
  return typeof param === 'string' && UUID_PARAM_RE.test(param);
}

export function UuidHandleRedirect({ userId, pathPrefix }: {
  userId: string;
  /** Route family to land on once the handle is known. */
  pathPrefix: '/u' | '/passport';
}) {
  const insets = useSafeAreaInsets();
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    setNotFound(false);
    getProfileById(userId)
      .then((res) => {
        if (!active) return;
        const handle = res.ok ? (res.data as any)?.handle : null;
        if (typeof handle === 'string' && handle.length > 0) {
          router.replace(`${pathPrefix}/${encodeURIComponent(handle.replace(/^@+/, ''))}` as any);
        } else {
          setNotFound(true);
        }
      })
      .catch(() => { if (active) setNotFound(true); });
    return () => { active = false; };
  }, [userId, pathPrefix]);

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      <View style={st.header}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any))}
          style={st.backBtn}
          hitSlop={8}
          accessibilityLabel="Back"
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={{ width: 38 }} />
      </View>
      <View style={st.center}>
        {notFound ? (
          <>
            <Text style={st.stateIcon}>👤</Text>
            <Text style={st.stateTitle}>{PROFILE_NOT_FOUND_TITLE}</Text>
            <Text style={st.stateSub}>{PROFILE_NOT_FOUND_SUB}</Text>
          </>
        ) : (
          <ActivityIndicator color={color.signal} testID="uuid-redirect-loading" />
        )}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: 10,
  },
  backBtn: { padding: 6 },
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.md, minHeight: 300,
  },
  stateIcon: { fontSize: 56 },
  stateTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  stateSub: { ...t.body, color: color.mute, textAlign: 'center' },
});
