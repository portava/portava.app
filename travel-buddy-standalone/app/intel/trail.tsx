/**
 * Trail — the "where next?" movement follow-up (Intelligence Gathering / IG-06).
 *
 * The traveler picks a COARSE destination AREA (a neighborhood/district name from
 * the existing area vocabulary — never coordinates, never free text) and a
 * visibility. That sends the `trail` capture surface with `context: 'movement'`,
 * which the server maps to experience.next_move: captured PRIVATE, aggregate-only,
 * and never a single-user published claim.
 *
 * DELIBERATELY NOT COLLECTED HERE: the exit-reason question ("why are you
 * leaving?"). experience.exit_reason is not a contracted §4 claim (no registry
 * row, no TTL), and per the owner ruling it stays out of the payload until it is
 * contracted (a §4 row + a TTL migration). Sending it would only be refused.
 *
 * Gated on BOTH `intel_capture_quick_signal` and `intel_trail_followup` (the
 * Trail rides the capture write path). Off ⇒ inert. Fully suppressed during an
 * active Safe Return / emergency.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Check, AlertCircle } from 'lucide-react-native';
import { color, space, radius, typography } from '../../src/theme/tokens';
import { IntelModalScaffold } from '../../src/components/intel/IntelModalScaffold';
import { OptionPills } from '../../src/components/intel/OptionPills';
import { VisibilityPicker } from '../../src/components/intel/VisibilityPicker';
import { DisclosureControl } from '../../src/components/intel/DisclosureControl';
import { SuppressedNotice } from '../../src/components/intel/IntelBits';
import { useIntelPrompts } from '../../src/hooks/useIntelPrompts';
import { getCurrentGps } from '../../src/services/location';
import { fetchCityNeighborhoods } from '../../src/services/neighborhoods';
import { submitTrailMovement, makeIdempotencyKey } from '../../src/services/intelCapture';
import {
  DEFAULT_VISIBILITY,
  VISIBILITY_META,
  type Visibility,
  type CommercialDisclosure,
} from '../../src/lib/intel/contracts';

/** Parse an optional `areas` route param (a comma-separated area list) into names. */
function parseAreasParam(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return [...new Set(raw.split(',').map((a) => a.trim()).filter((a) => a.length > 0 && a.length <= 120))];
}

export default function TrailScreen() {
  const params = useLocalSearchParams<{ subjectId?: string; subjectName?: string; venue?: string; city?: string; areas?: string }>();
  const subjectId = typeof params.subjectId === 'string' ? params.subjectId : undefined;
  const subjectName = typeof params.subjectName === 'string' ? params.subjectName : undefined;
  const city = typeof params.city === 'string' ? params.city : undefined;

  const { captureEnabled, trailEnabled, safeReturnActive } = useIntelPrompts();
  const [visibility, setVisibility] = useState<Visibility>(DEFAULT_VISIBILITY);
  const [disclosure, setDisclosure] = useState<CommercialDisclosure | null>(null);

  // Coarse destination-area vocabulary: the current city's neighborhoods (names
  // only), plus any names passed in as a route param. NEVER coordinates, never a
  // free-text field. Fail-soft to whatever the param supplied.
  const [areas, setAreas] = useState<string[]>(() => parseAreasParam(params.areas));
  const [busyArea, setBusyArea] = useState<string | null>(null);
  const [sentArea, setSentArea] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<{ area: string; key: string } | null>(null);

  useEffect(() => {
    if (!captureEnabled || !trailEnabled || !city) return;
    let alive = true;
    getCurrentGps()
      .then(async (gps) => {
        if (!gps.granted || gps.lat == null || gps.lng == null) return;
        const res = await fetchCityNeighborhoods(city, gps.lat, gps.lng);
        if (!alive || !res?.areas) return;
        const names = res.areas.map((a) => a.name).filter((n) => typeof n === 'string' && n.length > 0 && n.length <= 120);
        setAreas((prev) => [...new Set([...prev, ...names])]);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [captureEnabled, trailEnabled, city]);

  const submit = useCallback(
    async (area: string) => {
      setError(null);
      setBusyArea(area);
      if (!keyRef.current || keyRef.current.area !== area) {
        keyRef.current = { area, key: makeIdempotencyKey('trail') };
      }
      const res = await submitTrailMovement({
        subjectId: subjectId!,
        destinationArea: area,
        visibility,
        commercialDisclosure: disclosure ?? undefined,
        idempotencyKey: keyRef.current.key,
      });
      setBusyArea(null);
      if (res.ok) {
        setSentArea(area);
        keyRef.current = null;
      } else {
        setError(
          res.code === 'feature_disabled'
            ? 'The Trail follow-up is turned off right now.'
            : res.error === 'not_configured'
              ? 'Not connected.'
              : 'Could not send — tap to retry.',
        );
      }
    },
    [subjectId, visibility, disclosure],
  );

  let body: React.ReactNode;
  if (!captureEnabled || !trailEnabled) {
    body = <SuppressedNotice reason="disabled" />;
  } else if (safeReturnActive) {
    body = <SuppressedNotice reason="safe_return" />;
  } else if (!subjectId) {
    body = (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>Open this from a place</Text>
        <Text style={styles.emptyBody}>The Trail follow-up attaches to the place you’re leaving.</Text>
      </View>
    );
  } else {
    body = (
      <>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Who can see this?</Text>
          <VisibilityPicker value={visibility} onChange={setVisibility} />
          <Text style={styles.shareNote}>
            {visibility === 'private' ? 'Kept to yourself. Nothing is shared.' : VISIBILITY_META[visibility].description}
          </Text>
        </View>

        <View style={styles.divider} />

        <DisclosureControl value={disclosure} onChange={setDisclosure} />

        <View style={styles.divider} />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Where next?</Text>
          {areas.length > 0 ? (
            <>
              <Text style={styles.prompt}>Pick the area you’re heading to</Text>
              <OptionPills
                options={areas}
                onSelect={submit}
                busyOption={busyArea}
                selectedOption={sentArea}
                testIDPrefix="intel-trail-area"
              />
              {sentArea ? (
                <View style={styles.sentRow}>
                  <Check size={13} color={color.success} />
                  <Text style={styles.sentText}>Thanks — headed to {sentArea}. Counted privately, only toward crowd trends.</Text>
                </View>
              ) : null}
              {error ? (
                <View style={styles.errorRow}>
                  <AlertCircle size={13} color={color.signal} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}
              <Text style={styles.footnote}>
                A coarse area only — never your exact location. Shared at the visibility you chose above.
              </Text>
            </>
          ) : (
            <Text style={styles.footnote}>
              No nearby areas to choose from yet. Your next stop is shared as a coarse area, never a precise place.
            </Text>
          )}
        </View>
      </>
    );
  }

  return (
    <IntelModalScaffold title="Where next?" subtitle={subjectName ?? 'Trail follow-up'}>
      {body}
    </IntelModalScaffold>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  sectionTitle: { ...typography.sectionTitle, color: color.ink },
  prompt: { ...typography.cardTitle, color: color.ink },
  shareNote: { ...typography.caption, color: color.mute },
  divider: { height: 1, backgroundColor: color.haze },
  footnote: { ...typography.caption, color: color.faint, lineHeight: 18 },
  sentRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sentText: { ...typography.caption, color: color.success, flexShrink: 1 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { ...typography.caption, color: color.signal },
  emptyCard: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: 6,
  },
  emptyTitle: { ...typography.cardTitle, color: color.ink },
  emptyBody: { ...typography.caption, color: color.mute, lineHeight: 19 },
});
