/**
 * LayoverCrewLocationCard — §14 L4 "temporary location — explicit, scoped,
 * auto-expiring", beside the crew card (census-layover L132, L166, L277; the
 * map half of L124 is `LayoverMapCard`'s `crewLocations`, fed by `onRead`).
 *
 * A SIBLING of `LayoverCrewSection`, not a child: it makes its own read, and
 * it draws NOTHING unless that read says the traveller is in a crew and the
 * server's `layover_crew_location_enabled` is on.
 *
 * ── THE SHARE IS TELEGRAPH'S SCOPED SHARE ───────────────────────────────────
 * The same window list (`SCOPED_LOCATION_MINUTES`, never past the server's
 * four-hour ceiling), the same default (one hour), the same precision ladder
 * opening on "Approximate area". What is added is the layover's own end: the
 * server cuts a share at the traveller's boarding time and at the crew's end,
 * and says so.
 *
 * ── "EXACT" IS A SEPARATE SWITCH, OFF BY DEFAULT (L166) ─────────────────────
 * Telegraph's sheet offers Exact as a second tap. Spec §17.1 asks more of crew
 * sharing: a SEPARATE control, off by default. So Exact is not even offered
 * until the server says this traveller's precise-sharing switch for this crew
 * is on, and turning it off ends an exact share on the server at once.
 *
 * ── NO DEVICE POSITION ──────────────────────────────────────────────────────
 * The layover client imports no location API (census L164). A share is a
 * label the traveller types or a plan stop they pick; a stop's coordinates go
 * only with Venue or Exact, never with Approximate area.
 *
 * This card decides nothing about who may see what or when a share ends: both
 * arrive from the server (`GET /crew/location`).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { fmtClock } from './layoverFormat.ts';
import { getPlanStops } from '../../services/layover.ts';
import {
  PRECISION_TEXT,
  PROXIMITY_TEXT,
  getCrewLocation,
  setCrewPreciseControl,
  shareCrewLocation,
  shareExpiryFor,
  stopCrewLocation,
  type CrewLocationRead,
  type CrewSharePrecision,
  type GeoPoint,
} from '../../services/layoverCrewLocation.ts';
import { SCOPED_LOCATION_DEFAULT_MINUTES, SCOPED_LOCATION_MINUTES } from '../../features/telegraph/composer/TypedComposePrompt.tsx';

interface Props {
  sessionId: string;
  timezone: string | null;
  refreshKey?: number;
  /**
   * Every read this card lands, so the screen can hand the SAME crewmates to
   * `LayoverMapCard`'s `crewLocations` (the map element, L124) without a
   * second read that could disagree with this one.
   */
  onRead?: (read: CrewLocationRead) => void;
}

interface Pick { id: string; label: string; point: GeoPoint }

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return h === 1 ? '1 hour' : `${h} hours`;
}

const WITHHELD_TEXT = 'Some crewmates’ locations could not be checked just now, so none are shown.';

export function LayoverCrewLocationCard({ sessionId, timezone, refreshKey = 0, onRead }: Props) {
  const [read, setRead] = useState<CrewLocationRead | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [precision, setPrecision] = useState<CrewSharePrecision>('area');
  const [minutes, setMinutes] = useState<number>(SCOPED_LOCATION_DEFAULT_MINUTES);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Newest read wins, as in LayoverCrewSection.
  const ticket = useRef(0);
  // Held in a ref so an inline `onRead` cannot turn every parent render into a re-read.
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const refresh = useCallback(async () => {
    const mine = ++ticket.current;
    const r = await getCrewLocation(sessionId);
    if (mine !== ticket.current) return;
    setRead(r);
    onReadRef.current?.(r);
  }, [sessionId]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const openSheet = useCallback(async () => {
    setOpen(true);
    setNotice(null);
    // Places the traveller already has, with coordinates: their own plan stops.
    try {
      const stops = await getPlanStops(sessionId);
      setPicks((stops?.stops ?? [])
        .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
        .map((s) => ({ id: s.id, label: s.title, point: { lat: s.lat as number, lng: s.lng as number } })));
    } catch {
      setPicks([]);
    }
  }, [sessionId]);

  const reset = () => { setOpen(false); setLabel(''); setPrecision('area'); setMinutes(SCOPED_LOCATION_DEFAULT_MINUTES); setPicked(null); };

  const run = useCallback(async (key: string, act: () => Promise<{ ok: true } | { ok: false; message: string }>, after?: () => void) => {
    setBusy(key);
    setNotice(null);
    const out = await act();
    setBusy(null);
    if (!out.ok) { setNotice(out.message); return; }
    after?.();
    await refresh();
  }, [refresh]);

  if (read === null) return null;
  if (!read.ok) {
    return (
      <View style={styles.block}>
        <Text style={styles.note} testID="layover-crew-location-unavailable">Crew locations are unavailable right now.</Text>
      </View>
    );
  }
  // The server's flag is off, or this traveller is in no crew: nothing to draw.
  if (!read.available) return null;
  if (!read.inCrew) return null;

  const precise = read.preciseControl?.enabled === true;
  const offered: CrewSharePrecision[] = precise ? ['area', 'venue', 'exact'] : ['area', 'venue'];
  const windows = SCOPED_LOCATION_MINUTES.filter((m) => m <= read.maxShareMinutes);
  const maxShareMinutes = read.maxShareMinutes;
  const send = () => {
    const text = label.trim();
    if (!text) { setNotice('Say where you are first.'); return; }
    void run('share', () => shareCrewLocation(sessionId, {
      label: text,
      precision,
      expiresAt: shareExpiryFor(minutes, Date.now(), maxShareMinutes),
      point: picked?.point ?? null,
    }), reset);
  };

  return (
    <View style={styles.block} testID="layover-crew-location">
      <View style={styles.headRow}>
        <MapPin size={14} color={color.deep} />
        <Text style={styles.heading}>Where the crew is</Text>
      </View>
      <Text style={styles.note}>
        Only your crew sees a share, and only until it ends — at most {durationLabel(read.maxShareMinutes)}, and never past your boarding time.
      </Text>

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.body}>Allow exact location with this crew</Text>
          <Text style={styles.note}>Off by default. Area and venue shares never need it.</Text>
        </View>
        <Switch
          testID="layover-crew-location-precise-switch"
          accessibilityLabel="Allow exact location with this crew"
          value={precise}
          disabled={read.preciseControl === null || busy !== null}
          onValueChange={(v) => { void run('precise', () => setCrewPreciseControl(sessionId, v)); }}
        />
      </View>

      {read.mine ? (
        <View style={styles.mine} testID="layover-crew-location-mine">
          <Text style={styles.body}>
            You are sharing: {read.mine.label} · {PRECISION_TEXT[read.mine.precision]} · until {fmtClock(read.mine.endsAt, timezone)}
          </Text>
          <Pressable
            testID="layover-crew-location-stop"
            accessibilityRole="button"
            accessibilityLabel="Stop sharing my location with the crew"
            disabled={busy !== null}
            onPress={() => { void run('stop', () => stopCrewLocation(sessionId)); }}
            style={styles.secondaryBtn}
          >
            {busy === 'stop' ? <ActivityIndicator size="small" color={color.deep} /> : <Text style={styles.secondaryText}>Stop sharing</Text>}
          </Pressable>
        </View>
      ) : !open ? (
        <Pressable
          testID="layover-crew-location-share-open"
          accessibilityRole="button"
          accessibilityLabel="Share where I am with my crew"
          onPress={() => { void openSheet(); }}
          style={styles.secondaryBtn}
        >
          <Text style={styles.secondaryText}>Share where I am</Text>
        </Pressable>
      ) : null}

      {open && !read.mine ? (
        <View style={styles.sheet} testID="layover-crew-location-sheet">
          <TextInput
            testID="layover-crew-location-label"
            value={label}
            onChangeText={(v) => { setLabel(v); if (picked && v !== picked.label) setPicked(null); }}
            placeholder="Where are you? e.g. Night market, by the north gate"
            placeholderTextColor={color.faint}
            maxLength={200}
            accessibilityLabel="Where you are"
            style={styles.input}
          />
          {picks.length > 0 ? (
            <View style={styles.row} accessibilityLabel="One of your plan stops">
              {picks.map((p) => (
                <Pressable
                  key={p.id}
                  testID={`layover-crew-location-pick-${p.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: picked?.id === p.id }}
                  onPress={() => { setPicked(p); setLabel(p.label); }}
                  style={[styles.chip, picked?.id === p.id ? styles.chipOn : null]}
                >
                  <Text style={[styles.chipText, picked?.id === p.id ? styles.chipTextOn : null]}>{p.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.row} accessibilityLabel="How precisely">
            {offered.map((p) => (
              <Pressable
                key={p}
                testID={`layover-crew-location-precision-${p}`}
                accessibilityRole="button"
                accessibilityLabel={PRECISION_TEXT[p]}
                accessibilityState={{ selected: precision === p }}
                onPress={() => setPrecision(p)}
                style={[styles.chip, precision === p ? styles.chipOn : null]}
              >
                <Text style={[styles.chipText, precision === p ? styles.chipTextOn : null]}>{PRECISION_TEXT[p]}</Text>
              </Pressable>
            ))}
          </View>
          {precision === 'area' && picked ? (
            <Text style={styles.note}>Approximate area shares the name only — no pin.</Text>
          ) : null}
          <View style={styles.row} accessibilityLabel="How long to share">
            {windows.map((m) => (
              <Pressable
                key={m}
                testID={`layover-crew-location-duration-${m}`}
                accessibilityRole="button"
                accessibilityLabel={`Share for ${durationLabel(m)}`}
                accessibilityState={{ selected: minutes === m }}
                onPress={() => setMinutes(m)}
                style={[styles.chip, minutes === m ? styles.chipOn : null]}
              >
                <Text style={[styles.chipText, minutes === m ? styles.chipTextOn : null]}>{durationLabel(m)}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.note}>Ends by itself after {durationLabel(minutes)}, or when you board — whichever is first.</Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={reset} style={styles.secondaryBtn}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="layover-crew-location-send"
              accessibilityRole="button"
              accessibilityLabel="Share with my crew"
              disabled={busy !== null}
              onPress={send}
              style={styles.primaryBtn}
            >
              {busy === 'share' ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={styles.primaryText}>Share</Text>}
            </Pressable>
          </View>
        </View>
      ) : null}

      {read.crewmates.length > 0 ? (
        <View style={styles.list}>
          {read.crewmates.map((c) => {
            const who = c.name ?? (c.handle ? `@${c.handle}` : 'A crewmate');
            return (
              <View key={c.userId} testID={`layover-crew-location-mate-${c.userId}`} style={styles.mate}>
                <Text style={styles.body}>{who}: {c.label} · {PRECISION_TEXT[c.precision]} · until {fmtClock(c.endsAt, timezone)}</Text>
                {c.proximity ? <Text style={styles.note}>{who} is {PROXIMITY_TEXT[c.proximity]}.</Text> : null}
              </View>
            );
          })}
        </View>
      ) : read.crewmatesWithheld ? null : (
        <Text style={styles.note}>Nobody else in your crew is sharing right now.</Text>
      )}
      {read.crewmatesWithheld ? <Text style={styles.note} testID="layover-crew-location-withheld">{WITHHELD_TEXT}</Text> : null}
      {notice ? <Text style={styles.notice} testID="layover-crew-location-notice">{notice}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading: { ...t.bodyStrong, color: color.ink },
  body: { ...t.small, color: color.ink },
  note: { ...t.small, color: color.mute },
  notice: { ...t.small, color: color.warn },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  mine: { gap: 6 },
  sheet: { gap: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 8, color: color.ink, minHeight: 44 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: color.haze },
  chipOn: { backgroundColor: color.deep },
  chipText: { ...t.small, color: color.mute },
  chipTextOn: { color: color.onInk, fontWeight: '700' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  primaryBtn: { paddingHorizontal: space.lg, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: color.deep },
  primaryText: { ...t.small, color: color.onInk, fontWeight: '700' },
  secondaryBtn: { alignSelf: 'flex-start', paddingVertical: 6 },
  secondaryText: { ...t.small, color: color.deep, textDecorationLine: 'underline' },
  list: { gap: 6 },
  mate: { gap: 2 },
});

export default LayoverCrewLocationCard;
