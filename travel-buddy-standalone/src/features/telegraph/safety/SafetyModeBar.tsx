/**
 * Telegraph §15.2 — safety mode PROMOTES and DE-PRIORITIZES, on the screen.
 *
 * census-telegraph T218: "§15.2's promotion list now EXISTS as server-side
 * data in the spec's own order … It stays W for exactly the half the row names:
 * NOTHING REORDERS." This is the half that reorders. While the conversation's
 * safety mode is raised, the affordances §15.2 names move to the top of the
 * conversation, in the order the SERVER served them — trusted contact, current
 * status, official help, route/return, call, block/report, location scope —
 * and the screen is told to put entertainment out of the way.
 *
 * WHAT IT DOES NOT DECIDE. It does not compute the mode (the server derives it
 * from what people said) and it does not invent an order (it renders the list
 * it was handed, top to bottom). An affordance id this build does not know is
 * skipped rather than guessed at, and an affordance the screen cannot perform
 * (no callback passed) is not drawn: an inert safety button is worse than none.
 *
 * A FAILED READ IS NOT A CALM CONVERSATION. A refresh that fails while the mode
 * is raised keeps the raised bar on screen — the last thing measured — rather
 * than clearing it. Only a successful NORMAL answer takes it down. A first read
 * that fails draws nothing, because nothing was ever measured; the screen's
 * ordinary safety controls (header call, the safety sheet) are untouched.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { sendTypedMessage } from '../kinds/kindsApi.ts';
import { EmergencyHelpSheet } from '../../../components/safeReturn/EmergencyHelpSheet.tsx';
import { SafeReturnSetupSheet } from '../../../components/safeReturn/SafeReturnSetupSheet.tsx';
import {
  deprioritizesEntertainment,
  fetchSafetyMode,
  isSafetyRaised,
  type SafetyModeResponse,
} from './safetyModeApi.ts';

export const EMERGENCY_CONTACTS_ROUTE = '/profile/edit/emergency-contacts';

export interface SafetyModeBarProps {
  threadId: string;
  /** Changes when the conversation changes (e.g. the newest message id); a change re-reads the mode. */
  refreshKey?: string | null;
  /** Test seam: render this instead of fetching. */
  initialResponse?: SafetyModeResponse | null;
  /** §15.2 CALL. Absent → not drawn. */
  onCall?: () => void;
  /** §15.2 BLOCK_OR_REPORT. Absent → not drawn. */
  onBlockOrReport?: () => void;
  /** §15.2 LOCATION_SCOPE. Absent → not drawn. */
  onLocationScope?: () => void;
  /** Told whenever the measured mode changes, so the screen can put entertainment away. */
  onModeChange?: (state: { raised: boolean; deprioritizeEntertainment: boolean }) => void;
}

export function SafetyModeBar({
  threadId,
  refreshKey = null,
  initialResponse = null,
  onCall,
  onBlockOrReport,
  onLocationScope,
  onModeChange,
}: SafetyModeBarProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [data, setData] = useState<SafetyModeResponse | null>(initialResponse);
  const [helpOpen, setHelpOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const r = await fetchSafetyMode(threadId);
    if (mine !== generation.current) return;
    // A failed read keeps whatever was last measured. See the header.
    if (r.ok) setData(r.data);
  }, [threadId]);

  useEffect(() => {
    if (initialResponse !== null) return;
    void load();
  }, [initialResponse, load, refreshKey]);

  const raised = isSafetyRaised(data?.mode);
  const deprioritize = deprioritizesEntertainment(data);
  // Told on CHANGE only. The callback is read through a ref so a screen that
  // passes an inline arrow is not re-told on every render — which would fight
  // a person who has deliberately re-opened what was put away.
  const onModeChangeRef = useRef(onModeChange);
  useEffect(() => {
    onModeChangeRef.current = onModeChange;
  });
  useEffect(() => {
    onModeChangeRef.current?.({ raised, deprioritizeEntertainment: deprioritize });
  }, [raised, deprioritize]);

  const postStatus = useCallback(
    async (kind: 'check_in' | 'need_help') => {
      setStatusBusy(true);
      const r = await sendTypedMessage(threadId, 'SAFETY', {
        kind,
        label: kind === 'check_in' ? "I'm OK" : 'I need help',
      });
      setStatusBusy(false);
      if (!r.ok) {
        setStatusError(r.message ?? 'Your status was not sent.');
        return;
      }
      setStatusError(null);
      if (initialResponse === null) void load();
    },
    [threadId, initialResponse, load],
  );

  if (!data || !raised) return null;

  const controls: React.ReactNode[] = [];
  for (const id of data.affordances.promoted) {
    switch (id) {
      case 'TRUSTED_CONTACT':
        controls.push(
          <Chip key={id} id={id} label="Trusted contacts" styles={styles} onPress={() => router.push(EMERGENCY_CONTACTS_ROUTE)} />,
        );
        break;
      case 'CURRENT_STATUS':
        controls.push(
          <Chip key={`${id}-ok`} id={`${id}-ok`} label="I'm OK" styles={styles} disabled={statusBusy} onPress={() => void postStatus('check_in')} />,
          <Chip key={`${id}-help`} id={`${id}-help`} label="I need help" styles={styles} attention disabled={statusBusy} onPress={() => void postStatus('need_help')} />,
        );
        break;
      case 'OFFICIAL_HELP':
        controls.push(<Chip key={id} id={id} label="Emergency help" styles={styles} attention onPress={() => setHelpOpen(true)} />);
        break;
      case 'ROUTE_OR_RETURN':
        controls.push(<Chip key={id} id={id} label="Safe Return" styles={styles} onPress={() => setReturnOpen(true)} />);
        break;
      case 'CALL':
        if (onCall) controls.push(<Chip key={id} id={id} label="Call" styles={styles} onPress={onCall} />);
        break;
      case 'BLOCK_OR_REPORT':
        if (onBlockOrReport) controls.push(<Chip key={id} id={id} label="Block or report" styles={styles} onPress={onBlockOrReport} />);
        break;
      case 'LOCATION_SCOPE':
        if (onLocationScope) controls.push(<Chip key={id} id={id} label="Share a place" styles={styles} onPress={onLocationScope} />);
        break;
      default:
        // Unknown to this build: skipped, never guessed at.
        break;
    }
  }

  return (
    <View style={styles.wrap} testID="telegraph-safety-mode-bar" accessibilityRole="summary">
      <Text style={styles.title}>{data.mode === 'SAFETY_EVENT' ? 'Someone asked for help' : 'Safety heads-up'}</Text>
      <Text style={styles.reason}>{data.reason}</Text>
      <View style={styles.row}>{controls}</View>
      {statusError ? (
        <Text style={styles.reason} testID="telegraph-safety-status-error">
          {statusError}
        </Text>
      ) : null}
      <EmergencyHelpSheet
        visible={helpOpen}
        onClose={() => setHelpOpen(false)}
        onMessageTrustedCircle={() => {
          setHelpOpen(false);
          router.push(EMERGENCY_CONTACTS_ROUTE);
        }}
      />
      <SafeReturnSetupSheet
        visible={returnOpen}
        onClose={() => setReturnOpen(false)}
        onStarted={() => setReturnOpen(false)}
        suggestionReason="Someone in this conversation raised a safety concern."
      />
    </View>
  );
}

function Chip({
  id,
  label,
  onPress,
  styles,
  attention = false,
  disabled = false,
}: {
  id: string;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  attention?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={`telegraph-safety-affordance-${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, attention ? styles.chipAttention : null]}
    >
      <Text style={[styles.chipText, attention ? styles.chipTextAttention : null]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    // §11.1: the attention colour is RESERVED for safety. This is safety.
    wrap: {
      backgroundColor: p.surfaceRaised,
      borderLeftWidth: 3,
      borderLeftColor: p.attention,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.hairline,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      gap: 6,
    },
    title: { ...t.body, color: p.attention, fontWeight: '800' },
    reason: { ...t.small, color: p.mute },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: p.chipFill },
    chipAttention: { backgroundColor: p.attention },
    chipText: { ...t.small, color: p.recvText },
    chipTextAttention: { color: p.attentionOn, fontWeight: '700' },
  });
}

export default SafetyModeBar;
