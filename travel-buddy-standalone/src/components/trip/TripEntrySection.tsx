/**
 * TripEntrySection — entry requirements / visa status for a trip's travelers.
 *
 * Flag-gated: returns null when fetchTripEntryRequirements returns null
 * (feature flag off in prod, unconfigured API, network error, etc.).
 *
 * Caller's own card: full detail with status chip, allowed stay, source link,
 * last-verified date, and disclaimer verbatim.
 * Other travelers: compact row with status chip and passport-selected label.
 * No-passport state: prompt card + PassportPickerSheet.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Modal,
  FlatList,
  StyleSheet,
  Linking,
} from 'react-native';
import { closeThenNavigate } from '../../lib/deferredNavigate.ts';
import { ShieldCheck, ChevronRight, Globe, Clock } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import {
  fetchTripEntryRequirements,
  listMyPassports,
  setTripPassport,
  type TripEntryTraveler,
  type TravelerPassport,
} from '../../services/entryRequirements.ts';

// ── Status chip ───────────────────────────────────────────────────────────────

type StatusKey =
  | 'VISA-FREE'
  | 'VISA ON ARRIVAL'
  | 'EVISA'
  | 'VISA REQUIRED'
  | 'ADDITIONAL APPROVAL'
  | 'RESTRICTED'
  | 'UNKNOWN';

function normalizeStatus(raw: string): StatusKey {
  const up = raw.toUpperCase().trim();
  if (up === 'VISA_FREE' || up === 'VISA-FREE' || up === 'VISA FREE') return 'VISA-FREE';
  if (up === 'VISA_ON_ARRIVAL' || up === 'VISA ON ARRIVAL') return 'VISA ON ARRIVAL';
  if (up === 'EVISA' || up === 'E_VISA' || up === 'E-VISA') return 'EVISA';
  if (up === 'VISA_REQUIRED' || up === 'VISA REQUIRED') return 'VISA REQUIRED';
  if (up === 'ADDITIONAL_APPROVAL' || up === 'ADDITIONAL APPROVAL') return 'ADDITIONAL APPROVAL';
  if (up === 'RESTRICTED') return 'RESTRICTED';
  return 'UNKNOWN';
}

function chipColors(status: StatusKey): { bg: string; text: string } {
  switch (status) {
    case 'VISA-FREE':
      return { bg: color.success, text: color.onInk };
    case 'VISA ON ARRIVAL':
    case 'EVISA':
      return { bg: color.warn, text: color.onInk };
    case 'VISA REQUIRED':
    case 'ADDITIONAL APPROVAL':
    case 'RESTRICTED':
      return { bg: color.signal, text: color.onInk };
    case 'UNKNOWN':
    default:
      return { bg: color.mute, text: color.onInk };
  }
}

function StatusChip({ rawStatus }: { rawStatus: string }) {
  const status = normalizeStatus(rawStatus);
  const { bg, text } = chipColors(status);
  return (
    <View style={[chip.base, { backgroundColor: bg }]}>
      <Text style={[chip.label, { color: text }]}>{status}</Text>
    </View>
  );
}

// ── Passport picker sheet ─────────────────────────────────────────────────────

interface PassportPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (passport: TravelerPassport) => void;
}

function PassportPickerSheet({ visible, onClose, onSelect }: PassportPickerSheetProps) {
  const [passports, setPassports] = useState<TravelerPassport[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    listMyPassports().then((list) => {
      if (!cancelled) {
        setPassports(list);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={sheet.scrim} onPress={onClose} />
      <View style={sheet.panel}>
        <View style={sheet.handle} />
        <Text style={sheet.title}>Choose a passport</Text>

        {loading ? (
          <View style={sheet.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : (
          <FlatList
            data={passports}
            keyExtractor={(p) => p.id}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [sheet.row, pressed && { opacity: 0.75 }]}
                onPress={() => onSelect(item)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={sheet.rowLabel}>{item.label || item.issuingCountry}</Text>
                  <Text style={sheet.rowSub}>{item.issuingCountry}</Text>
                </View>
                {item.isPrimary && (
                  <View style={sheet.primaryBadge}>
                    <Text style={sheet.primaryBadgeText}>Primary</Text>
                  </View>
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={sheet.empty}>No passports on file yet.</Text>
            }
          />
        )}

        <Pressable
          style={sheet.addRow}
          onPress={() => {
            // BUG CC/CD fix: defer navigation until after the sheet close animation.
            closeThenNavigate(onClose, '/profile/edit/passports');
          }}
        >
          <Text style={sheet.addText}>Add passport</Text>
          <ChevronRight size={14} color={color.signal} />
        </Pressable>
      </View>
    </Modal>
  );
}

// ── Caller's own status card ──────────────────────────────────────────────────

function CallerStatusCard({
  traveler,
  disclaimer,
}: {
  traveler: TripEntryTraveler;
  disclaimer: string;
}) {
  const req = traveler.requirement as Record<string, unknown> | null | undefined;
  const allowedStayDays = typeof req?.allowedStayDays === 'number' ? req.allowedStayDays : null;
  const sourceUrl = typeof req?.sourceUrl === 'string' ? req.sourceUrl : null;
  const lastVerified = traveler.lastVerifiedAt
    ? new Date(traveler.lastVerifiedAt).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : null;

  const unknownReason =
    traveler.unknownReason && normalizeStatus(traveler.status) === 'UNKNOWN'
      ? traveler.unknownReason
      : null;

  return (
    <View style={card.wrap}>
      <View style={card.topRow}>
        <StatusChip rawStatus={traveler.status} />
        {allowedStayDays != null && (
          <View style={card.stayPill}>
            <Clock size={12} color={color.mute} />
            <Text style={card.stayText}>
              {allowedStayDays === 1 ? '1 day' : `${allowedStayDays} days`}
            </Text>
          </View>
        )}
      </View>

      {unknownReason ? (
        <Text style={card.unknownText}>{unknownReason}</Text>
      ) : null}

      {sourceUrl ? (
        <Pressable
          style={card.sourceRow}
          onPress={() => Linking.openURL(sourceUrl).catch(() => {})}
        >
          <Globe size={13} color={color.signal} />
          <Text style={card.sourceText}>Official source</Text>
          <ChevronRight size={13} color={color.signal} />
        </Pressable>
      ) : null}

      {lastVerified ? (
        <Text style={card.verifiedText}>Last verified {lastVerified}</Text>
      ) : null}

      {disclaimer ? (
        <Text style={card.disclaimer}>{disclaimer}</Text>
      ) : null}
    </View>
  );
}

// ── Other-traveler compact row ────────────────────────────────────────────────

function OtherTravelerRow({ traveler }: { traveler: TripEntryTraveler }) {
  return (
    <View style={row.wrap}>
      <StatusChip rawStatus={traveler.status} />
      <Text style={row.passportLabel}>
        {traveler.passportSelected ? 'Passport selected' : 'No passport selected'}
      </Text>
    </View>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

interface TripEntrySectionProps {
  tripId: string;
  /** Called once after the first fetch resolves — true when data is available. */
  onLoad?: (hasContent: boolean) => void;
}

export function TripEntrySection({ tripId, onLoad }: TripEntrySectionProps) {
  const [entryData, setEntryData] = useState<{
    destinationCountry: string | null;
    disclaimer: string;
    travelers: TripEntryTraveler[];
  } | null | undefined>(undefined); // undefined = not yet loaded
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingPassport, setSettingPassport] = useState(false);
  const reportedRef = React.useRef(false);

  const load = useCallback(async () => {
    const data = await fetchTripEntryRequirements(tripId);
    setEntryData(data); // null = feature off; object = have data
    if (!reportedRef.current) {
      reportedRef.current = true;
      onLoad?.(data !== null && data !== undefined);
    }
  }, [tripId, onLoad]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const handlePassportSelect = useCallback(async (passport: TravelerPassport) => {
    setPickerOpen(false);
    setSettingPassport(true);
    await setTripPassport(tripId, passport.id);
    setSettingPassport(false);
    load();
  }, [tripId, load]);

  // Not yet loaded — render nothing (avoids a flash)
  if (entryData === undefined) return null;
  // Feature flag off or API unavailable
  if (entryData === null) return null;

  const selfTraveler = entryData.travelers.find((t) => t.self);
  const others = entryData.travelers.filter((t) => !t.self);
  const noPassport = selfTraveler && !selfTraveler.passportSelected;

  return (
    <View style={s.section}>
      <View style={s.header}>
        <ShieldCheck size={15} color={color.signal} />
        <Text style={s.headerText}>Entry &amp; visas</Text>
      </View>

      {/* No passport on file → prompt */}
      {noPassport ? (
        <View style={s.promptCard}>
          <Text style={s.promptTitle}>Which passport will you be traveling with?</Text>
          <Pressable
            style={[s.promptBtn, settingPassport && { opacity: 0.6 }]}
            onPress={() => setPickerOpen(true)}
            disabled={settingPassport}
          >
            {settingPassport ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : (
              <Text style={s.promptBtnText}>Choose passport</Text>
            )}
          </Pressable>
        </View>
      ) : selfTraveler ? (
        <CallerStatusCard
          traveler={selfTraveler}
          disclaimer={entryData.disclaimer}
        />
      ) : null}

      {/* Other travelers */}
      {others.length > 0 ? (
        <View style={s.othersWrap}>
          <Text style={s.othersLabel}>Other travelers</Text>
          {others.map((t, i) => (
            <OtherTravelerRow key={t.userId ?? i} traveler={t} />
          ))}
        </View>
      ) : null}

      <PassportPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePassportSelect}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  section: {
    paddingHorizontal: space.lg,
    marginTop: space.xl,
    gap: space.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: space.xs,
  },
  headerText: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
  },
  promptCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.md,
    ...shadow.card,
  },
  promptTitle: {
    ...t.body,
    color: color.ink,
  },
  promptBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    alignItems: 'center',
  },
  promptBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
  othersWrap: {
    gap: space.sm,
    marginTop: space.xs,
  },
  othersLabel: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
});

const chip = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});

const card = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
    ...shadow.card,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  stayPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.paper,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  stayText: {
    fontSize: 12,
    color: color.mute,
    fontWeight: '600',
  },
  unknownText: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  sourceText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
    flex: 1,
  },
  verifiedText: {
    fontSize: 11,
    color: color.faint,
  },
  disclaimer: {
    fontSize: 11,
    color: color.faint,
    lineHeight: 16,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: space.sm,
  },
});

const row = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  passportLabel: {
    ...t.small,
    color: color.mute,
  },
});

const sheet = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  panel: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: 32,
    maxHeight: '70%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.lg,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    paddingHorizontal: space.lg,
    marginBottom: space.md,
  },
  center: {
    padding: space.xl,
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  rowLabel: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  rowSub: {
    ...t.small,
    color: color.mute,
  },
  primaryBadge: {
    backgroundColor: color.paper,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: color.haze,
  },
  primaryBadgeText: {
    fontSize: 11,
    color: color.mute,
    fontWeight: '600',
  },
  empty: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    padding: space.xl,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    marginTop: space.xs,
  },
  addText: {
    ...t.bodyStrong,
    color: color.signal,
    flex: 1,
    fontSize: 14,
  },
});
