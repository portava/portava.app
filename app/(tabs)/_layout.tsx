import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Tabs, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, Compass, Map, User } from 'lucide-react-native';
import { color, space, type as t, shadow } from '../../src/theme/tokens';

/** Center vermilion passport-stamp create button. */
function StampButton() {
  return (
    <Pressable
      onPress={() => router.push('/create')}
      style={styles.stampBtn}
      accessibilityRole="button"
      accessibilityLabel="Share a travel post"
    >
      <View style={styles.stampInner}>
        <Text style={styles.stampGlyph}>✛</Text>
        <Text style={styles.stampWord}>POST</Text>
      </View>
    </Pressable>
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: true,
        tabBarActiveTintColor: color.ink,
        tabBarInactiveTintColor: color.faint,
        tabBarStyle: [styles.bar, { height: 58 + insets.bottom, paddingBottom: insets.bottom }],
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Pulse',
          tabBarIcon: ({ color: c }) => <Activity size={22} color={c} />,
        }}
      />
      <Tabs.Screen
        name="discovery"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color: c }) => <Compass size={22} color={c} />,
        }}
      />
      <Tabs.Screen
        name="create-tab"
        options={{
          title: '',
          tabBarButton: () => <StampButton />,
        }}
        listeners={{ tabPress: (e) => { e.preventDefault(); router.push('/create'); } }}
      />
      <Tabs.Screen
        name="trips"
        options={{
          title: 'Trips',
          tabBarIcon: ({ color: c }) => <Map size={22} color={c} />,
        }}
      />
      <Tabs.Screen
        name="passport"
        options={{
          title: 'Passport',
          tabBarIcon: ({ color: c }) => <User size={22} color={c} />,
        }}
      />
      {/* AI chat lives off-tab, reachable from headers/cards */}
      <Tabs.Screen name="ai" options={{ href: null, title: 'AI' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: color.paperRaised,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: 6,
  },
  label: { ...t.stamp, fontFamily: 'Courier', marginTop: 2 },
  stampBtn: {
    top: -18,
    alignSelf: 'center',
    width: 62,
    height: 62,
    ...shadow.float,
  },
  stampInner: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-6deg' }],
    borderWidth: 2,
    borderColor: color.signalDim,
  },
  stampGlyph: { color: color.onInk, fontSize: 20, lineHeight: 22, fontWeight: '900' },
  stampWord: {
    color: color.onInk, fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 1,
  },
});
