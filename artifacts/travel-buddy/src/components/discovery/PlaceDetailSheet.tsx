import React from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet, Linking,
} from 'react-native';
import { X, MapPin, Globe, Phone, Tag, Plus } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { color, space, radius, type as t, shadow } from '../../theme/tokens';
import { categoryColor } from './PlaceCard';

interface PlaceDetailSheetProps {
  place: DiscoveryPlace | null;
  visible: boolean;
  onClose: () => void;
  onAddToPlan: (place: DiscoveryPlace) => void;
}

export function PlaceDetailSheet({ place, visible, onClose, onAddToPlan }: PlaceDetailSheetProps) {
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
          {(place.website || place.phone || (place.lat != null && place.lng != null)) && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Links</Text>
              <View style={styles.linkRow}>
                {place.website && (
                  <Pressable style={styles.linkBtn} onPress={openWeb}>
                    <Globe size={15} color={color.deep} />
                    <Text style={styles.linkText}>Website</Text>
                  </Pressable>
                )}
                {place.phone && (
                  <Pressable style={styles.linkBtn} onPress={openPhone}>
                    <Phone size={15} color={color.deep} />
                    <Text style={styles.linkText}>{place.phone}</Text>
                  </Pressable>
                )}
                {place.lat != null && place.lng != null && (
                  <Pressable style={styles.linkBtn} onPress={openMap}>
                    <MapPin size={15} color={color.deep} />
                    <Text style={styles.linkText}>Open in Maps</Text>
                  </Pressable>
                )}
              </View>
            </View>
          )}

          {/* Attribution */}
          <Text style={styles.attribution}>
            Place data from OpenStreetMap contributors (ODbL)
          </Text>
        </ScrollView>

        {/* Add to Plan CTA */}
        <View style={styles.footer}>
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
    maxHeight: '80%',
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
    gap: space.md,
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
  },
  attribution: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
    textAlign: 'center',
    marginTop: space.md,
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
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
