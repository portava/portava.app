import React, { useEffect, useState } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet, Linking,
} from 'react-native';
import { X, MapPin, Globe, Phone, Tag, Plus, Bookmark, Navigation, Clock, Star } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { checkSaved, toggleSave } from '../../services/collections';
import { color, space, radius, type as t, shadow } from '../../theme/tokens';
import { categoryColor } from './PlaceCard';

interface PlaceDetailSheetProps {
  place: DiscoveryPlace | null;
  visible: boolean;
  onClose: () => void;
  onAddToPlan: (place: DiscoveryPlace) => void;
}

export function PlaceDetailSheet({ place, visible, onClose, onAddToPlan }: PlaceDetailSheetProps) {
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (place) {
      checkSaved('place', place.id)
        .then(({ saved }) => setSaved(saved))
        .catch(() => {});
    }
  }, [place?.id]);

  if (!place) return null;

  const accent = categoryColor(place.category);

  const openWeb = () => {
    if (place.website) Linking.openURL(place.website).catch(() => {});
  };

  const openPhone = () => {
    if (place.phone) Linking.openURL(`tel:${place.phone}`).catch(() => {});
  };

  const openMap = () => {
    if (place.lat != null && place.lng != null) {
      const url = `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}&zoom=17`;
      Linking.openURL(url).catch(() => {});
    } else {
      const q = encodeURIComponent(place.name + (place.address ? ` ${place.address}` : ''));
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
    }
  };

  const openDirections = () => {
    if (place.lat != null && place.lng != null) {
      Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`).catch(() => {});
    } else {
      const q = encodeURIComponent(place.name);
      Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${q}`).catch(() => {});
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={styles.sheet}>
        {/* Handle */}
        <View style={styles.handle} />

        {/* Header */}
        <View style={styles.header}>
          <View style={[styles.accentDot, { backgroundColor: accent }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={2}>{place.name}</Text>
            {place.type ? (
              <Text style={[styles.type, { color: accent }]}>{capitalize(place.type)}</Text>
            ) : null}
          </View>
          <Pressable
            style={({ pressed }) => [styles.saveHeaderBtn, saved && styles.saveHeaderBtnActive, pressed && { opacity: 0.7 }]}
            onPress={() => {
              if (!place) return;
              const next = !saved;
              setSaved(next);
              toggleSave('place', place.id, !next)
                .then(setSaved)
                .catch(() => setSaved((s) => !s));
            }}
            hitSlop={8}
          >
            <Bookmark size={18} color={saved ? color.signal : color.mute} fill={saved ? color.signal : 'none'} />
          </Pressable>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Distance */}
          {place.distanceKm != null && (
            <View style={styles.infoRow}>
              <MapPin size={15} color={color.mute} />
              <Text style={styles.infoText}>
                {place.distanceKm < 1
                  ? `${Math.round(place.distanceKm * 1000)}m from city centre`
                  : `${place.distanceKm}km from city centre`}
              </Text>
            </View>
          )}

          {/* Address */}
          {place.address && (
            <View style={styles.infoRow}>
              <MapPin size={15} color={color.mute} />
              <Text style={styles.infoText}>{place.address}</Text>
            </View>
          )}

          {/* Rating */}
          {place.rating != null && (
            <View style={styles.infoRow}>
              <Star size={15} color="#F59E0B" fill="#F59E0B" />
              <Text style={[styles.infoText, { color: color.ink, fontWeight: '600' }]}>
                {place.rating.toFixed(1)}
                <Text style={[styles.infoText, { fontWeight: '400' }]}> · OSM community rating</Text>
              </Text>
            </View>
          )}

          {/* Opening hours */}
          {place.openingHours && (
            <View style={styles.infoRow}>
              <Clock size={15} color={color.mute} />
              <Text style={styles.infoText}>{place.openingHours}</Text>
            </View>
          )}

          {/* Map thumbnail area — tap to open */}
          {place.lat != null && place.lng != null && (
            <Pressable style={styles.mapThumb} onPress={openMap}>
              <Navigation size={18} color={color.deep} />
              <View>
                <Text style={styles.mapThumbTitle}>View on map</Text>
                <Text style={styles.mapThumbSub}>
                  {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
                </Text>
              </View>
            </Pressable>
          )}

          {/* Description */}
          {place.description && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>About</Text>
              <Text style={styles.desc}>{place.description}</Text>
            </View>
          )}

          {/* Tags */}
          {place.tags.length > 0 && (
            <View style={styles.section}>
              <View style={styles.infoRow}>
                <Tag size={14} color={color.mute} />
                <Text style={styles.sectionLabel}>Tags</Text>
              </View>
              <View style={styles.tagRow}>
                {place.tags.map((tag) => (
                  <View key={tag} style={[styles.tag, { backgroundColor: accent + '18' }]}>
                    <Text style={[styles.tagText, { color: accent }]}>{capitalize(tag)}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Links */}
          {(place.website || place.phone) && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Contact</Text>
              <View style={styles.linkRow}>
                {place.website && (
                  <Pressable style={styles.linkBtn} onPress={openWeb}>
                    <Globe size={15} color={color.deep} />
                    <Text style={styles.linkText} numberOfLines={1}>Website</Text>
                  </Pressable>
                )}
                {place.phone && (
                  <Pressable style={styles.linkBtn} onPress={openPhone}>
                    <Phone size={15} color={color.deep} />
                    <Text style={styles.linkText}>{place.phone}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          )}

          {/* Attribution */}
          <Text style={styles.attribution}>
            Place data © OpenStreetMap contributors (ODbL)
          </Text>
        </ScrollView>

        {/* Footer actions */}
        <View style={styles.footer}>
          <Pressable style={styles.dirBtn} onPress={openDirections}>
            <Navigation size={18} color={color.deep} />
            <Text style={styles.dirText}>Directions</Text>
          </Pressable>
          <Pressable style={styles.addBtn} onPress={() => onAddToPlan(place)}>
            <Plus size={18} color={color.onInk} />
            <Text style={styles.addText}>Add to Plan</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '82%',
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    ...shadow.float,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  accentDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 5,
  },
  name: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  type: {
    ...t.stamp,
    fontSize: 11,
    marginTop: 2,
    textTransform: 'capitalize',
  },
  saveHeaderBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveHeaderBtnActive: {
    backgroundColor: color.signal + '18',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: space.md,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  infoText: {
    ...t.small,
    color: color.mute,
    flex: 1,
  },
  mapThumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: '#E2EDF0',
    borderRadius: radius.md,
    padding: space.md,
  },
  mapThumbTitle: {
    ...t.bodyStrong,
    color: color.deep,
    fontSize: 13,
  },
  mapThumbSub: {
    ...t.stamp,
    color: color.mute,
    fontSize: 10,
    marginTop: 2,
  },
  section: {
    gap: space.sm,
  },
  sectionLabel: {
    ...t.stamp,
    color: color.faint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  desc: {
    ...t.body,
    color: color.ink,
    fontSize: 14,
    lineHeight: 21,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  tag: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
  },
  tagText: {
    ...t.stamp,
    fontSize: 11,
    textTransform: 'capitalize',
  },
  linkRow: {
    gap: space.sm,
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  linkText: {
    ...t.body,
    color: color.deep,
    fontSize: 14,
    flex: 1,
  },
  attribution: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
    textAlign: 'center',
    marginTop: space.md,
  },
  footer: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  dirBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flex: 1,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    borderWidth: 1.5,
    borderColor: color.deep,
  },
  dirText: {
    ...t.bodyStrong,
    color: color.deep,
    fontWeight: '700',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flex: 2,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
  },
  addText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontWeight: '700',
  },
});

export default PlaceDetailSheet;
