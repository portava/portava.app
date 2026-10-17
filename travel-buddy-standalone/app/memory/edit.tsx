/**
 * Memory edit screen — /memory/edit?id=<uuid>
 *
 * Lets the owner change title, caption, visibility, location and explicit
 * start/end times. Navigates back to the detail screen on success.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import {
  View, Text, ScrollView, Pressable, TextInput,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { router, useLocalSearchParams, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Globe, Users, Lock, Eye, MapPin, ChevronDown } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  getMemory, updateMemory, newMemoryOperationId, type Memory, type MemoryVisibility,
} from '../../src/services/memories';
import { useSession } from '../../src/context/SessionContext.tsx';
import { supabase } from '../../src/lib/supabase.ts';
import { memoryOwnerSessionId, type MemoryOwnerRequest } from '../../src/services/memoryOwnerRequest.ts';
import { MemoryNarrativeDraft } from '../../src/features/memories/MemoryNarrativeDraft.tsx';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { placeToLocationFields } from '../../src/lib/location/locationPayload';
import type { Place } from '../../src/lib/location/placeTypes'; import { MemoryTypePicker } from '../../src/features/memories/canonical/MemoryTypePicker.tsx'; import { isMemoryType, memoryPlaceLine, occurrenceNameOfPick, type MemoryType } from '../../src/features/memories/canonical/memoryCanonical.ts'; // H40/H71; on this line so no cited line moves

// ── Visibility options ────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS: {
  value: MemoryVisibility;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  { value: 'public',       label: 'Public',    desc: 'Everyone',       icon: <Globe  size={15} color={color.success} /> },
  { value: 'friends_only', label: 'Friends',   desc: 'Mutual follows', icon: <Users  size={15} color={color.signal} /> },
  { value: 'trip_crew',    label: 'Trip crew', desc: 'Trip members',   icon: <Eye    size={15} color={color.deep} /> },
  { value: 'only_me',      label: 'Only me',   desc: 'Private draft',  icon: <Lock   size={15} color={color.mute} /> },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Place-like object from existing memory location fields so the
 *  picker row shows the saved city name on first load. */
function memoryToPlace(memory: Memory): Place | null {
  if (!memory.locationCity && !memory.locationCountry) return null;
  return {
    id: memory.placeId ?? '',
    displayName: memoryPlaceLine(memory), // H71: the place's name as recorded, when the server serves it; otherwise city, country as before
    name: memory.locationCity ?? memory.locationCountry ?? '',
    city: memory.locationCity ?? undefined,
    country: memory.locationCountry ?? undefined,
    lat: memory.locationLat ?? undefined,
    lng: memory.locationLng ?? undefined,
    type: 'city',
  } as Place;
}

type MemoryTimeDraft = {
  original: string | null;
  date: string;
  time: string;
  offset: string;
  touched: boolean;
  cleared: boolean;
};

const memoryTimeSchema = z.string().datetime({ offset: true });

function memoryTimeDraft(original: string | null | undefined): MemoryTimeDraft {
  const parts = original?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/);
  return { original: original ?? null, date: parts?.[1] ?? '', time: parts?.[2] ?? '',
    offset: parts?.[3] ?? '', touched: false, cleared: false };
}

function memoryTimeValue(draft: MemoryTimeDraft, bound: 'start' | 'end'):
  { ok: true; value: string | null | undefined } | { ok: false; message: string } {
  if (!draft.touched) return { ok: true, value: undefined };
  if (draft.cleared) return { ok: true, value: null };
  const value = `${draft.date}T${draft.time}${draft.offset}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)
    || !/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(draft.time)
    || !/^(Z|[+-]\d{2}:?\d{2})$/.test(draft.offset)
    || !memoryTimeSchema.safeParse(value).success || !Number.isFinite(Date.parse(value))) {
    return { ok: false, message: `Enter a complete ${bound} date (YYYY-MM-DD), time (HH:mm:ss) and UTC offset (Z or ±HH:mm), or choose Clear ${bound}.` };
  }
  return { ok: true, value: value === draft.original ? undefined : value };
}

function memoryTimeInstant(value: string): { wholeSecond: number; fraction: string } | null {
  const parts = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/);
  if (!parts || !memoryTimeSchema.safeParse(value).success) return null;
  const wholeSecond = Date.parse(`${parts[1]}${parts[3]}`);
  return Number.isFinite(wholeSecond) ? { wholeSecond, fraction: parts[2] ?? '' } : null;
}

function memoryTimeBefore(earlier: string, later: string): boolean {
  const earlierInstant = memoryTimeInstant(earlier);
  const laterInstant = memoryTimeInstant(later);
  if (!earlierInstant || !laterInstant) return false;
  if (earlierInstant.wholeSecond !== laterInstant.wholeSecond) return earlierInstant.wholeSecond < laterInstant.wholeSecond;
  const precision = Math.max(earlierInstant.fraction.length, laterInstant.fraction.length);
  return earlierInstant.fraction.padEnd(precision, '0') < laterInstant.fraction.padEnd(precision, '0');
}

function MemoryTimeInputs({ bound, value, onChange, disabled }: {
  bound: 'start' | 'end'; value: MemoryTimeDraft; onChange: (next: MemoryTimeDraft) => void; disabled: boolean;
}) {
  const label = bound === 'start' ? 'Start' : 'End';
  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>{label} date and time</Text>
      {(value.cleared || (!value.original && !value.touched)) && <Text style={s.timeHelp}>{label} not set</Text>}
      {value.original !== null && <Text style={s.timeHelp}>Saved {bound}: {value.original}</Text>}
      <Text style={s.timeHelp}>Date (YYYY-MM-DD)</Text>
      <TextInput testID={`memory-${bound}-date`} accessibilityLabel={`${label} date (YYYY-MM-DD)`}
        style={s.input} value={value.date} placeholder="YYYY-MM-DD" editable={!disabled} autoCorrect={false} autoCapitalize="none"
        onChangeText={date => onChange({ ...value, date, touched: true, cleared: false })} />
      <Text style={s.timeHelp}>Time (24-hour HH:mm:ss; fractional seconds optional)</Text>
      <TextInput testID={`memory-${bound}-time`} accessibilityLabel={`${label} time (HH:mm:ss)`}
        style={s.input} value={value.time} placeholder="HH:mm:ss" editable={!disabled} autoCorrect={false} autoCapitalize="none"
        onChangeText={time => onChange({ ...value, time, touched: true, cleared: false })} />
      <Text style={s.timeHelp}>UTC offset (Z means UTC; for example +05:45 or -04:00)</Text>
      <TextInput testID={`memory-${bound}-offset`} accessibilityLabel={`${label} UTC offset`}
        style={s.input} value={value.offset} placeholder="Z or ±HH:mm" editable={!disabled} autoCorrect={false} autoCapitalize="none"
        onChangeText={offset => onChange({ ...value, offset, touched: true, cleared: false })} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Clear ${bound}`} disabled={disabled}
        onPress={() => onChange({ ...value, date: '', time: '', offset: '', touched: true, cleared: true })}>
        <Text style={s.backLinkText}>Clear {bound}</Text>
      </Pressable>
      {value.touched && <Pressable accessibilityRole="button" accessibilityLabel={`Restore saved ${bound}`} disabled={disabled}
        onPress={() => onChange(memoryTimeDraft(value.original))}>
        <Text style={s.backLinkText}>Restore saved {bound}</Text>
      </Pressable>}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function EditMemoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId, loading } = useSession();
  const target = useRef({ id, userId });
  target.current = { id, userId };
  const isTargetCurrent = useCallback(() => target.current.id === id && target.current.userId === userId, [id, userId]);
  if (!id) return <Redirect href="/memory/new" />;
  if (loading) return <View style={s.centered}><ActivityIndicator color={color.signal} /></View>;
  if (!userId) return (
    <View style={s.centered}>
      <Text style={s.errorText}>Sign in to edit this Memory.</Text>
      <Pressable onPress={() => router.back()} style={s.backLink}><Text style={s.backLinkText}>Go back</Text></Pressable>
    </View>
  );
  return <OwnerMemoryEditor key={`${userId}:${id}`} id={id} ownerId={userId} isTargetCurrent={isTargetCurrent} />;
}

function OwnerMemoryEditor({ id, ownerId, isTargetCurrent }: {
  id: string; ownerId: string; isTargetCurrent: () => boolean;
}) {
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');

  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [startTime, setStartTime] = useState(() => memoryTimeDraft(null));
  const [endTime, setEndTime] = useState(() => memoryTimeDraft(null));
  const [visibility, setVisibility] = useState<MemoryVisibility>('friends_only');
  const [place, setPlace] = useState<Place | null>(null);
  const [placePickerOpen, setPlacePickerOpen] = useState(false); const [memoryType, setMemoryType] = useState<MemoryType | null>(null); const typeTouched = useRef(false); const placeTouched = useRef(false); // §4 / §9: sent only when the person changed them here

  // Track whether the place was intentionally cleared (null after load).
  // We need to send explicit nulls when the user clears an existing location.
  const originalHadLocation = useRef(false);
  const saveLock = useRef(false);
  const lifecycle = useRef<AbortController | null>(null);
  const [request, setRequest] = useState<MemoryOwnerRequest | null>(null);
  const lastSave = useRef<{ intent: string; operationId: string } | null>(null);

  // ── Load existing memory ────────────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    let sessionId: string | null = null;
    const acceptsSession = (next: string | null) => {
      if (!next) return false;
      if (sessionId === null) sessionId = next;
      return sessionId === next;
    };
    const invalidateSession = () => {
      if (controller.signal.aborted || !isTargetCurrent()) return;
      controller.abort();
      setRequest(null); setTitle(''); setCaption(''); setPlace(null); setPlacePickerOpen(false);
      setStartTime(memoryTimeDraft(null)); setEndTime(memoryTimeDraft(null));
      setVisibility('friends_only'); setMemoryType(null); setSaveError(''); setSaving(false);
      lastSave.current = null;
      setLoadError('This editing session changed. Reopen the Memory.'); setLoading(false);
    };
    const scope: MemoryOwnerRequest = { memoryId: id, ownerId, signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && isTargetCurrent(), acceptsSession, invalidateSession };
    setRequest(scope);
    setLoading(true);
    setLoadError('');
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || session?.user.id !== ownerId
        || !acceptsSession(memoryOwnerSessionId(session.access_token))) invalidateSession();
    });
    (async () => {
      const result = await getMemory(id, scope);
      if (!scope.isCurrent()) return;
      setLoading(false);
      if (!result.ok) { setLoadError(result.message); return; }
      const m = result.memory;
      setTitle(m.title ?? '');
      setCaption(m.caption ?? '');
      setStartTime(memoryTimeDraft(m.startsAt)); setEndTime(memoryTimeDraft(m.endsAt));
      setVisibility(m.visibility as MemoryVisibility); setMemoryType(isMemoryType(m.memoryType) ? m.memoryType : null);
      const initialPlace = memoryToPlace(m);
      setPlace(initialPlace);
      originalHadLocation.current = initialPlace !== null;
    })();
    return () => { controller.abort(); subscription.unsubscribe(); };
  }, [id, ownerId, isTargetCurrent]);

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!request || !request.isCurrent() || request.signal.aborted || saveLock.current) return;
    const startResult = memoryTimeValue(startTime, 'start');
    const endResult = memoryTimeValue(endTime, 'end');
    if (!startResult.ok) { setSaveError(startResult.message); return; }
    if (!endResult.ok) { setSaveError(endResult.message); return; }
    const nextStart = startResult.value === undefined ? startTime.original : startResult.value;
    const nextEnd = endResult.value === undefined ? endTime.original : endResult.value;
    if ((startTime.touched || endTime.touched) && nextStart !== null && nextEnd !== null
      && memoryTimeBefore(nextEnd, nextStart)) {
      setSaveError('End must not be before start. Change or clear a time.'); return;
    }
    saveLock.current = true;
    setSaveError('');
    setSaving(true);

    try {
      // Derive location payload from the current place.
      // If the picker returned a full place, use placeToLocationFields.
      // If place is null and the memory originally had a location, send
      // explicit nulls so the backend clears the fields.
      const locationPayload = place
        ? placeToLocationFields(place)
        : originalHadLocation.current
          ? {
              locationCity: null as null,
              locationCountry: null as null,
              locationLat: null as null,
              locationLng: null as null,
              placeId: null as null,
              canonicalLocationId: null as null,
            }
          : {};

      const patch = {
        title: title.trim() || null,
        caption: caption.trim() || null,
        visibility,
        ...(startResult.value !== undefined ? { startsAt: startResult.value } : {}),
        ...(endResult.value !== undefined ? { endsAt: endResult.value } : {}),
        ...locationPayload, ...(typeTouched.current ? { memoryType } : {}), ...(placeTouched.current && place ? { placeDisplayNameAtOccurrence: occurrenceNameOfPick(place) } : {}), // a type is sent only when changed (the server refuses one while types are off); a place's name only with a NEWLY picked place
      };
      const intent = JSON.stringify(patch);
      if (lastSave.current?.intent !== intent) lastSave.current = { intent, operationId: newMemoryOperationId('memory-edit') };
      const result = await updateMemory(id, { ...patch, operationId: lastSave.current.operationId }, request);
      if (!request.isCurrent() || request.signal.aborted) return;

      if (!result.ok) {
        setSaveError(result.message);
        return;
      }

      router.back();
    } finally {
      if (request.isCurrent() && !request.signal.aborted) {
        setSaving(false);
        saveLock.current = false;
      }
    }
  }, [id, title, caption, visibility, place, memoryType, startTime, endTime, request]);

  const close = () => {
    lifecycle.current?.abort();
    setRequest(null);
    router.back();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[s.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={[s.centered, { paddingTop: insets.top }]}>
        <Text style={s.errorText}>{loadError}</Text>
        <Pressable onPress={() => router.back()} style={s.backLink}>
          <Text style={s.backLinkText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={close} hitSlop={8} style={s.headerClose} accessibilityLabel="Close editor">
          <X size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Edit Memory</Text>
        <Pressable
          onPress={() => { void handleSave(); }}
          disabled={saving}
          testID="memory-edit-save-btn"
          style={[s.saveBtn, saving && s.saveBtnDisabled]}
        >
          {saving
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={s.saveBtnText}>Save</Text>}
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[s.body, { paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled"
      >

        {/* Title */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Title</Text>
          <TextInput
            style={s.input}
            placeholder="Give this memory a name…"
            placeholderTextColor={color.faint}
            value={title}
            editable={!saving}
            onChangeText={setTitle}
            maxLength={300}
            returnKeyType="next"
          />
        </View>

        {/* Caption */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Caption</Text>
          <TextInput
            style={[s.input, s.inputMultiline]}
            placeholder="What made this moment special?"
            placeholderTextColor={color.faint}
            value={caption}
            editable={!saving}
            onChangeText={setCaption}
            maxLength={2000}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        {request && <MemoryNarrativeDraft request={request} disabled={saving} onUse={setCaption} />}

        <View style={s.section}>
          <Text style={s.sectionLabel}>When it happened</Text>
          <Text style={s.timeHelp}>Enter only times you know. Nothing changes until you choose Save. Clear removes a time; it does not replace it with today.</Text>
          <Text style={s.timeHelp}>An offset is not a place or time zone. These fields show the saved offset, not a guessed local time. Include the offset for the date you mean.</Text>
          <MemoryTimeInputs bound="start" value={startTime} onChange={setStartTime} disabled={saving} />
          <MemoryTimeInputs bound="end" value={endTime} onChange={setEndTime} disabled={saving} />
        </View>

        {/* §4 MemoryType (census H40) — shown only when the server accepts one */}
        <MemoryTypePicker value={memoryType} onChange={(next) => { typeTouched.current = true; setMemoryType(next); }} mode="edit" />

        {/* Location */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Location</Text>
          <Pressable
            style={s.locationRow}
            onPress={() => setPlacePickerOpen(true)}
            testID="memory-edit-location-row"
          >
            <View style={s.locationValue}>
              <MapPin size={16} color={place ? color.signal : color.mute} />
              <Text
                style={[s.locationText, !place && s.locationPlaceholder]}
                numberOfLines={1}
              >
                {place ? place.displayName : 'Add a location (optional)'}
              </Text>
            </View>
            {place ? (
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  setPlace(null);
                }}
                hitSlop={10}
                testID="memory-edit-location-clear"
              >
                <X size={16} color={color.mute} />
              </Pressable>
            ) : (
              <ChevronDown size={16} color={color.mute} />
            )}
          </Pressable>
        </View>

        {/* Visibility */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Who can see this?</Text>
          <View style={s.visGrid}>
            {VISIBILITY_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[s.visOption, visibility === opt.value && s.visOptionActive]}
                onPress={() => setVisibility(opt.value)}
              >
                {opt.icon}
                <Text style={[s.visLabel, visibility === opt.value && s.visLabelActive]}>
                  {opt.label}
                </Text>
                <Text style={s.visDesc}>{opt.desc}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {saveError ? <Text style={s.error}>{saveError}</Text> : null}

      </ScrollView>

      <GlobalPlacePicker
        visible={placePickerOpen}
        onClose={() => setPlacePickerOpen(false)}
        onSelect={(p) => { placeTouched.current = true; setPlace(p); }}
        title="Tag a Location"
        mode="all"
        usedFor="memory"
      />
    </KeyboardSafeScrollView>
  );
}

const s = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: color.paper },
  errorText: { ...(t.body as object), color: color.signal, textAlign: 'center', marginHorizontal: space.xl },
  backLink: { marginTop: space.md },
  backLinkText: { ...(t.body as object), color: color.signal },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  headerClose: { width: 36, alignItems: 'flex-start' },
  headerTitle: { ...(t.bodyStrong as object), color: color.ink },
  saveBtn: {
    backgroundColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    minWidth: 60,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { ...(t.small as object), color: '#fff', fontWeight: '700' },

  body: { padding: space.lg, gap: space.xl },

  section: { gap: space.sm },
  sectionLabel: { ...(t.bodyStrong as object), color: color.ink },
  timeHelp: { ...(t.small as object), color: color.mute },

  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    ...(t.body as object),
    color: color.ink,
    backgroundColor: color.paperRaised,
  },
  inputMultiline: { minHeight: 100 },

  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: color.paperRaised,
  },
  locationValue: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  locationText: { ...(t.body as object), color: color.ink, flex: 1 },
  locationPlaceholder: { color: color.faint },

  visGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  visOption: {
    flex: 1,
    minWidth: '45%',
    alignItems: 'center',
    gap: 4,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  visOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visLabel: { ...(t.small as object), color: color.ink, fontWeight: '700' },
  visLabelActive: { color: color.signal },
  visDesc: { fontSize: 10, color: color.mute, textAlign: 'center' },

  error: { ...(t.small as object), color: color.signal, textAlign: 'center' },
});
