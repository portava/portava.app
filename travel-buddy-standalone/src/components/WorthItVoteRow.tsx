/**
 * WorthItVoteRow — Worth It / Skip It voting for place and gem detail screens.
 *
 * - Fetches vote tallies on mount via GET /api/places/:id/votes
 * - Optimistic update on tap; rolls back with a toast on API failure
 * - Compact pill buttons: thumbs-up (worth it) + thumbs-down (skip it)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { ThumbsUp, ThumbsDown } from 'lucide-react-native';
import { getPlaceVotes, castPlaceVote, type PlaceVoteType } from '../services/reviews.ts';
import { useSession } from '../context/SessionContext.tsx';

interface WorthItVoteRowProps {
  /** UUID of the entity — place or hidden gem */
  entityId: string;
  /** 'place' for discovery_places, 'gem' for hidden_gems */
  entityType?: 'place' | 'gem';
}

export function WorthItVoteRow({ entityId, entityType = 'place' }: WorthItVoteRowProps) {
  const { isAuthed } = useSession();

  const [worthItCount, setWorthItCount] = useState(0);
  const [skipItCount,  setSkipItCount]  = useState(0);
  const [myVote,       setMyVote]       = useState<PlaceVoteType | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [casting,      setCasting]      = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getPlaceVotes(entityId, entityType)
      .then((data) => {
        if (!active) return;
        setWorthItCount(data.worthItCount);
        setSkipItCount(data.skipItCount);
        setMyVote(data.myVote);
      })
      .catch(() => {
        // Fail silently — votes section disappears, detail screen still works
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [entityId, entityType]);

  const handleVote = useCallback(async (vote: PlaceVoteType) => {
    if (!isAuthed) {
      Alert.alert('Sign in required', 'You need to sign in to vote.');
      return;
    }
    if (casting) return;

    // Optimistic update
    const prevMyVote      = myVote;
    const prevWorthIt     = worthItCount;
    const prevSkipIt      = skipItCount;

    setCasting(true);

    // If tapping same vote → remove; otherwise switch/set
    const nextVote: PlaceVoteType | null = myVote === vote ? null : vote;

    // Apply optimistic delta
    if (prevMyVote === 'worth_it') setWorthItCount((c) => Math.max(0, c - 1));
    if (prevMyVote === 'skip_it')  setSkipItCount((c)  => Math.max(0, c - 1));
    if (nextVote   === 'worth_it') setWorthItCount((c) => c + 1);
    if (nextVote   === 'skip_it')  setSkipItCount((c)  => c + 1);
    setMyVote(nextVote);

    try {
      const result = await castPlaceVote(entityId, entityType, nextVote);
      // Sync with server counts
      setWorthItCount(result.worthItCount);
      setSkipItCount(result.skipItCount);
      setMyVote(result.myVote);
    } catch {
      // Rollback on error
      setWorthItCount(prevWorthIt);
      setSkipItCount(prevSkipIt);
      setMyVote(prevMyVote);
      Alert.alert('Could not save vote', 'Please try again.');
    } finally {
      setCasting(false);
    }
  }, [isAuthed, casting, myVote, worthItCount, skipItCount, entityId, entityType]);

  if (loading) return null;

  const totalVotes = worthItCount + skipItCount;

  return (
    <View style={s.row}>
      <Text style={s.label}>Worth It?</Text>

      <View style={s.pills}>
        {/* Worth It */}
        <Pressable
          style={({ pressed }) => [
            s.pill,
            s.pillWorth,
            myVote === 'worth_it' && s.pillWorthActive,
            (pressed || casting) && { opacity: 0.7 },
          ]}
          onPress={() => handleVote('worth_it')}
          disabled={casting}
          accessibilityRole="button"
          accessibilityLabel={`Worth it, ${worthItCount} votes`}
        >
          <ThumbsUp
            size={14}
            color={myVote === 'worth_it' ? '#047857' : '#6B7280'}
            strokeWidth={myVote === 'worth_it' ? 2.5 : 1.8}
          />
          <Text style={[s.pillText, myVote === 'worth_it' && s.pillTextWorthActive]}>
            Worth it{worthItCount > 0 ? ` · ${worthItCount}` : ''}
          </Text>
        </Pressable>

        {/* Skip It */}
        <Pressable
          style={({ pressed }) => [
            s.pill,
            s.pillSkip,
            myVote === 'skip_it' && s.pillSkipActive,
            (pressed || casting) && { opacity: 0.7 },
          ]}
          onPress={() => handleVote('skip_it')}
          disabled={casting}
          accessibilityRole="button"
          accessibilityLabel={`Skip it, ${skipItCount} votes`}
        >
          <ThumbsDown
            size={14}
            color={myVote === 'skip_it' ? '#B91C1C' : '#6B7280'}
            strokeWidth={myVote === 'skip_it' ? 2.5 : 1.8}
          />
          <Text style={[s.pillText, myVote === 'skip_it' && s.pillTextSkipActive]}>
            Skip it{skipItCount > 0 ? ` · ${skipItCount}` : ''}
          </Text>
        </Pressable>
      </View>

      {totalVotes > 0 && (
        <Text style={s.tally}>
          {Math.round((worthItCount / totalVotes) * 100)}% recommend
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection:  'row',
    alignItems:     'center',
    flexWrap:       'wrap',
    gap:            8,
    paddingVertical: 10,
  },
  label: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#374151',
    marginRight: 2,
  },
  pills: {
    flexDirection: 'row',
    gap:           6,
    flex:          1,
    flexWrap:      'wrap',
  },
  pill: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            5,
    paddingVertical:  6,
    paddingHorizontal: 12,
    borderRadius:   999,
    borderWidth:    1,
    borderColor:    '#E5E7EB',
    backgroundColor: '#F9FAFB',
  },
  pillWorth:       {},
  pillWorthActive: { backgroundColor: '#ECFDF5', borderColor: '#A7F3D0' },
  pillSkip:        {},
  pillSkipActive:  { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },

  pillText: {
    fontSize:   12,
    fontWeight: '500',
    color:      '#6B7280',
  },
  pillTextWorthActive: { color: '#047857', fontWeight: '700' },
  pillTextSkipActive:  { color: '#B91C1C', fontWeight: '700' },

  tally: {
    fontSize:   11,
    color:      '#9CA3AF',
    marginLeft: 4,
  },
});
