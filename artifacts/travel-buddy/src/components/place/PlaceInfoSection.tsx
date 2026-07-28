/**
 * PlaceInfoSection — enriched location info card for detail screens.
 *
 * Renders: description, category, formatted address (tappable → Google Maps),
 * phone (tappable tel:), website (tappable), and opening hours (today + full
 * week expandable).
 *
 * Fields absent from the passed data are hidden entirely — no "N/A" rows.
 * A "Provisional — verify on arrival" disclaimer appears below hours and
 * contact info sourced from third-party APIs.
 *
 * Usage:
 *   // Canonical place (all enriched fields available)
 *   <PlaceInfoSection place={canonicalPlace} />
 *
 *   // Gem / user-contributed (only user-entered data; no FSQ enrichment)
 *   <PlaceInfoSection description={gem.description} category={gem.category} />
 *
 *   // With FSQ enrichment + user description override
 *   <PlaceInfoSection place={canonicalPlace} description={userDesc} />
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { Phone, Globe, MapPin, Clock, Tag, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { CanonicalPlace, NormalizedOpeningHours } from '../../types/canonicalPlace.ts';

// ── Day labels ────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Provisional disclaimer ────────────────────────────────────────────────────

function ProvisionalNote() {
  return (
    <View style={pi.provisionalRow}>
      <AlertCircle size={10} color={color.faint} />
      <Text style={pi.provisionalText}>Provisional — verify on arrival</Text>
    </View>
  );
}

// ── Hours block ───────────────────────────────────────────────────────────────

function HoursDisplay({ hours }: { hours: NormalizedOpeningHours }) {
  const [expanded, setExpanded] = useState(false);
  const today = new Date().getDay();
  const todayEntry = hours.find((h) => h.dayOfWeek === today);

  return (
    <View style={pi.hoursBlock}>
      <Pressable
        style={pi.infoRow}
        onPress={() => setExpanded((v) => !v)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse opening hours' : 'Expand opening hours'}
      >
        <Clock size={13} color={color.deep} />
        <Text style={[pi.infoText, pi.infoLink]}>
          {todayEntry
            ? `${DAY_SHORT[today]}: ${todayEntry.open} – ${todayEntry.close}`
            : 'Hours not available'}
        </Text>
        {expanded
          ? <ChevronUp size={13} color={color.mute} />
          : <ChevronDown size={13} color={color.mute} />}
      </Pressable>

      {expanded && (
        <View style={pi.fullHoursTable}>
          {DAY_NAMES.map((dayName, dayIdx) => {
            const entry = hours.find((h) => h.dayOfWeek === dayIdx);
            const isToday = dayIdx === today;
            return (
              <View key={dayIdx} style={[pi.dayRow, isToday && pi.dayRowToday]}>
                <Text style={[pi.dayName, isToday && pi.dayNameToday]}>{dayName}</Text>
                <Text style={[pi.dayHours, isToday && pi.dayNameToday]}>
                  {entry ? `${entry.open} – ${entry.close}` : 'Closed'}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      <ProvisionalNote />
    </View>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PlaceInfoSectionProps {
  /** Full canonical place — contact, hours, address sourced from FSQ / Google. */
  place?: CanonicalPlace | null;
  /** User-entered description override (e.g. gem description). */
  description?: string | null;
  /** Category override (e.g. gem category string). */
  category?: string | null;
  /**
   * When true, only renders the full opening-hours block + provisional note.
   * Use alongside PlaceCard (which already shows name, address, phone, website).
   * Defaults to false (renders all available fields).
   */
  supplemental?: boolean;
  /**
   * Individual enrichment overrides — take priority over `place` fields.
   * Use when you have FSQ contact data without a full CanonicalPlace (e.g.
   * event venue enrichment via /api/places/nearby-venue).
   */
  phone?: string | null;
  website?: string | null;
  openingHours?: NormalizedOpeningHours | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlaceInfoSection({ place, description, category, supplemental = false, phone: phoneProp, website: websiteProp, openingHours: openingHoursProp }: PlaceInfoSectionProps) {
  const desc    = description ?? place?.description ?? null;
  const cat     = category ?? (place?.category ? String(place.category).replace(/_/g, ' ') : null);
  const phone   = phoneProp ?? place?.phone ?? null;
  const website = websiteProp ?? place?.website ?? null;
  const address = place?.formattedAddress ?? place?.address ?? null;
  const placeHours = place?.openingHours && place.openingHours.length > 0 ? place.openingHours : null;
  const hours   = (openingHoursProp && openingHoursProp.length > 0) ? openingHoursProp : placeHours;

  // Supplemental mode: only full hours (PlaceCard handles the rest of the fields)
  if (supplemental) {
    if (!hours) return null;
    return (
      <View style={pi.container}>
        <Text style={pi.sectionLabel}>Opening Hours</Text>
        <HoursDisplay hours={hours} />
      </View>
    );
  }

  const hasContent = !!(desc || cat || phone || website || address || hours);
  if (!hasContent) return null;

  const hasContactInfo = !!(phone || website);

  return (
    <View style={pi.container}>
      {/* Description */}
      {desc ? (
        <Text style={pi.desc}>{desc}</Text>
      ) : null}

      {/* Category */}
      {cat ? (
        <View style={pi.infoRow}>
          <Tag size={13} color={color.mute} />
          <Text style={pi.infoText} numberOfLines={2}>
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </Text>
        </View>
      ) : null}

      {/* Address — tappable → opens Google Maps */}
      {address ? (
        <Pressable
          style={pi.infoRow}
          onPress={() => {
            const q = encodeURIComponent(address);
            Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
          }}
          accessibilityRole="button"
          accessibilityLabel={`Open ${address} in maps`}
        >
          <MapPin size={13} color={color.deep} />
          <Text style={[pi.infoText, pi.infoLink]} numberOfLines={3}>{address}</Text>
        </Pressable>
      ) : null}

      {/* Phone — tappable tel: link */}
      {phone ? (
        <Pressable
          style={pi.infoRow}
          onPress={() => Linking.openURL(`tel:${phone}`).catch(() => {})}
          accessibilityRole="button"
          accessibilityLabel={`Call ${phone}`}
        >
          <Phone size={13} color={color.deep} />
          <Text style={[pi.infoText, pi.infoLink]}>{phone}</Text>
        </Pressable>
      ) : null}

      {/* Website — opens in-app browser via Linking */}
      {website ? (
        <Pressable
          style={pi.infoRow}
          onPress={() => Linking.openURL(website).catch(() => {})}
          accessibilityRole="button"
          accessibilityLabel="Open website"
        >
          <Globe size={13} color={color.deep} />
          <Text style={[pi.infoText, pi.infoLink]} numberOfLines={1}>
            {website.replace(/^https?:\/\/(www\.)?/, '')}
          </Text>
        </Pressable>
      ) : null}

      {/* Provisional disclaimer — shown when contact info is from third-party API */}
      {hasContactInfo ? <ProvisionalNote /> : null}

      {/* Opening hours — today + expandable full week */}
      {hours ? <HoursDisplay hours={hours} /> : null}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pi = StyleSheet.create({
  container: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
    marginBottom: space.md,
  },

  sectionLabel: {
    ...t.stamp,
    fontSize: 10,
    color: color.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },

  desc: {
    ...t.body,
    color: color.ink,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 2,
  },

  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  infoText: {
    ...t.small,
    color: color.mute,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  infoLink: {
    color: color.deep,
    textDecorationLine: 'underline',
  },

  provisionalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  provisionalText: {
    ...t.small,
    fontSize: 10,
    color: color.faint,
    fontStyle: 'italic',
  },

  // ── Hours ──────────────────────────────────────────────────────────────────
  hoursBlock: {
    gap: space.xs,
  },
  fullHoursTable: {
    backgroundColor: color.haze,
    borderRadius: radius.sm,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    gap: 2,
    marginTop: space.xs,
  },
  dayRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  dayRowToday: {
    backgroundColor: color.deep + '10',
    borderRadius: 4,
    paddingHorizontal: 4,
    marginHorizontal: -4,
  },
  dayName: {
    ...t.small,
    fontSize: 12,
    color: color.mute,
    minWidth: 80,
  },
  dayNameToday: {
    color: color.deep,
    fontWeight: '700',
  },
  dayHours: {
    ...t.small,
    fontSize: 12,
    color: color.mute,
  },
});
