/**
 * Shown INSTEAD of the app when the build's database and API belong to
 * different deployments (src/lib/deploymentConsistency.ts). The app never
 * starts in that state: a session from one deployment must not be sent to the
 * other. The screen says what is wrong and what to do; it names no secret.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export function DeploymentMisconfiguredScreen({ problem }: { problem: string }) {
  return (
    <View style={s.root} accessibilityRole="alert" testID="deployment-misconfigured">
      <Text style={s.title}>This build is misconfigured</Text>
      <Text style={s.body}>{problem}</Text>
      <Text style={s.body}>
        Portava will not start, so nothing is sent to the wrong place. Please install the correct build, or tell
        the Portava team which build you have.
      </Text>
    </View>
  );
}

/** Renders `children` only when `problem` is null; otherwise the error screen, and the children never mount. */
export function DeploymentGate({ problem, children }: { problem: string | null; children: React.ReactNode }) {
  if (problem) return <DeploymentMisconfiguredScreen problem={problem} />;
  return <>{children}</>;
}

const s = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#141F3B' },
  title: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  body: { color: 'rgba(255,255,255,0.8)', fontSize: 15, lineHeight: 21, marginTop: 8, textAlign: 'center' },
});
