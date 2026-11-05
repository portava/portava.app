import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { ds } from '../shared/discoveryStyles.ts';
import { writeFailureText, type ApiRead } from '../shared/discoveryApi.ts';
import { decideTrailSuggestion, getTrailSuggestions, type TrailSuggestion } from './trailsApi.ts';
import { hrefForItem, SOURCE_LABEL } from './trailModel.ts';

export function TrailSuggestionsView({ onNavigate, load = getTrailSuggestions, decide = decideTrailSuggestion }: {
  onNavigate: (href: string) => void; load?: typeof getTrailSuggestions; decide?: typeof decideTrailSuggestion;
}) {
  const [read, setRead] = useState<ApiRead<TrailSuggestion[]> | undefined>();
  const generation = useRef(0);
  const run = useCallback(async () => {
    const request = ++generation.current;
    setRead(undefined);
    try {
      const result = await load();
      if (request === generation.current) setRead(result);
    } catch {
      if (request === generation.current) setRead({ state: 'unavailable', detail: 'Connection interrupted. Please try again.' });
    }
  }, [load]);
  useEffect(() => { void run(); return () => { generation.current++; }; }, [run]);
  return <ScrollView testID="trail-suggestions">
    <Text style={ds.notice}>Review requests to include your content in a Trail. Nothing is added until you accept.</Text>
    {read === undefined ? <ActivityIndicator testID="trail-suggestions-loading" />
      : read.state === 'off' ? <Text style={ds.notice}>Trail suggestions are currently unavailable.</Text>
      : read.state === 'unavailable' ? <View>
        <Text style={ds.notice}>Your suggestions could not be loaded. Please try again.</Text>
        <Pressable accessibilityRole="button" testID="trail-suggestions-retry" style={ds.button} onPress={() => { void run(); }}><Text style={ds.buttonText}>Try again</Text></Pressable>
      </View>
      : read.data.length === 0 ? <Text style={ds.notice} testID="trail-suggestions-empty">No suggestions waiting for you.</Text>
      : <>
        {read.data.map((item) => <SuggestionRow key={item.id} item={item} decide={decide} onNavigate={onNavigate} />)}
        <Pressable style={ds.button} accessibilityRole="button" testID="trail-suggestions-refresh" onPress={() => { void run(); }}><Text style={ds.buttonText}>Check for more suggestions</Text></Pressable>
      </>}
  </ScrollView>;
}

function SuggestionRow({ item, onNavigate, decide }: {
  item: TrailSuggestion; onNavigate: (href: string) => void; decide: typeof decideTrailSuggestion;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<'accepted' | 'declined' | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const apply = async (decision: 'accept' | 'decline') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const answer = await decide(item.id, decision);
      if (!alive.current) return;
      if (answer.state === 'done') setResult(answer.data.state);
      else setError(writeFailureText(answer));
    } catch { if (alive.current) setError('Your decision could not be confirmed. Please try again.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const href = hrefForItem(item);
  return <View style={ds.card} testID={`trail-suggestion-${item.id}`}>
    <Text style={ds.heading}>{SOURCE_LABEL[item.sourceType] ?? 'Content'} suggestion</Text>
    <Text style={ds.notice}>{item.relationship === 'primary' ? 'Main feature' : item.relationship === 'supporting' ? 'Related recommendation' : 'Trail recommendation'}</Text>
    <View style={ds.chips}>
      {href ? <Pressable accessibilityRole="button" style={ds.ghost} onPress={() => onNavigate(href)}><Text style={ds.ghostText}>View your content</Text></Pressable> : null}
      <Pressable accessibilityRole="button" style={ds.ghost} onPress={() => onNavigate(`/trails/${encodeURIComponent(item.trailId)}`)}><Text style={ds.ghostText}>View Trail</Text></Pressable>
    </View>
    {result ? <Text style={ds.notice} testID={`trail-suggestion-result-${item.id}`}>{result === 'accepted' ? 'Accepted. Your content is included in this Trail.' : 'Declined. Your content was not added.'}</Text> : <>
      {error ? <Text style={ds.notice} accessibilityRole="alert" testID={`trail-suggestion-error-${item.id}`}>{error}</Text> : null}
      <View style={ds.chips}>
        {(['accept', 'decline'] as const).map((decision) => <Pressable key={decision} style={ds.ghost} accessibilityRole="button"
          disabled={busy} accessibilityState={{ busy }} testID={`trail-suggestion-${decision}-${item.id}`} onPress={() => { void apply(decision); }}>
          <Text style={ds.ghostText}>{decision === 'accept' ? 'Accept' : 'Decline'}</Text>
        </Pressable>)}
      </View>
    </>}
  </View>;
}
