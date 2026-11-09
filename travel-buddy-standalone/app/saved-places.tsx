import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Bookmark, FolderPlus, MapPin } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { EmptyState } from '../src/components/ui/EmptyState';
import { ErrorState } from '../src/components/ui/ErrorState';
import { SaveToCollectionSheet } from '../src/components/SaveToCollectionSheet';
import { usePrivateSurfaceKey } from '../src/hooks/usePrivateSurfaceKey';
import { loadSavedPlaces, fileSavedPlace, type SavedPlaceSummary } from '../src/services/savedPlaces';
import { color, space, type as t } from '../src/theme/tokens';

export default function SavedPlacesScreen() {
  return <SavedPlacesList key={usePrivateSurfaceKey()} />;
}

function SavedPlacesList() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof loadSavedPlaces>> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<SavedPlaceSummary | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setRefreshing(true);
    try {
      const next = await loadSavedPlaces();
      if (generation.current === request) setResult(next);
    } catch {
      if (generation.current === request) {
        setResult(previous => ({state:'unavailable', places:previous?.places ?? [], unavailableSources:['wishlist','community','collections']}));
      }
    } finally {
      if (generation.current === request) setRefreshing(false);
    }
  }, []);
  useFocusEffect(useCallback(() => {
    void reload();
    return () => { generation.current++; };
  }, [reload]));
  const placeFiling = useMemo(() => selected ? {
    collectionIds: selected.collectionIds,
    fileInto: async (id: string) => (await fileSavedPlace(selected.placeId, id)).ok,
  } : undefined, [selected]);
  const close = useCallback(() => setSelected(null), []);
  const notice = result?.state === 'offline' ? 'Offline. Showing places saved on this device.'
    : result && result.state !== 'ready' ? 'Some saved places could not be loaded.' : null;
  return <View style={s.page}>
    <AppHeader variant="detail" title="Saved places" onBack={router.back} />
    {!result ? <ActivityIndicator color={color.signal} /> :
      <FlatList data={result.places} keyExtractor={row => row.key} onRefresh={reload} refreshing={refreshing}
        contentContainerStyle={s.list}
        ListHeaderComponent={notice ? <ErrorState message={notice} onRetry={reload} /> : null}
        ListEmptyComponent={result.state === 'ready' ? <EmptyState icon={Bookmark} title="No saved places yet" description="Bookmark a place on Discovery or the map to find it here." /> : null}
        renderItem={({item}) => <View style={s.row}>
          <Pressable style={s.place} accessibilityRole="button" accessibilityLabel={`Open ${item.title}`}
            onPress={() => router.push({pathname:'/place/[id]',params:{id:item.placeId, name:item.title,
              ...(item.latitude != null && item.longitude != null ? {lat:String(item.latitude), lng:String(item.longitude)} : {})}} as never)}>
            <MapPin color={color.deep} size={20} />
            <View style={s.label}><Text style={s.title}>{item.title}</Text>
              {[item.city,item.country].filter(Boolean).length > 0 && <Text style={s.detail}>{[item.city,item.country].filter(Boolean).join(', ')}</Text>}
              {item.pending && <Text style={s.detail}>Waiting to sync</Text>}
            </View>
          </Pressable>
          <Pressable style={s.file} accessibilityRole="button" accessibilityLabel={`Organize ${item.title}`} onPress={() => setSelected(item)}>
            <FolderPlus color={color.deep} size={20} />
          </Pressable>
        </View>} />}
    {selected && placeFiling && <SaveToCollectionSheet key={selected.key} visible entityType="place" entityId={selected.placeId}
      isSaved savedPlace={placeFiling} onClose={close} onSaved={() => { close(); void reload(); }} />}
  </View>;
}

const s = StyleSheet.create({
  page:{flex:1,backgroundColor:color.paper}, list:{padding:space.lg,flexGrow:1},
  row:{flexDirection:'row',alignItems:'center',borderBottomColor:color.faint,borderBottomWidth:StyleSheet.hairlineWidth},
  place:{flex:1,flexDirection:'row',alignItems:'center',gap:space.md,paddingVertical:space.md},
  label:{flex:1}, title:{...t.body,color:color.ink,fontWeight:'700'}, detail:{...t.body,color:color.mute},
  file:{padding:space.md},
});
