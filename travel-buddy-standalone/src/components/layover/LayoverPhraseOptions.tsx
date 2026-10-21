import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { LayoverPhraseSet } from '../../services/layover.ts';
export function LayoverPhraseOptions({ set }: { set: LayoverPhraseSet }) {
  const [language, choose] = useState(set.language);
  const options = set.languageOptions ?? [], current = options.find(o => o.language === language) ?? options[0];
  if (!current) return null;
  return <View testID="layover-phrase-language-options">
    {options.length > 1 ? <Text>Choose a language. Other local languages may not be included.</Text> : null}
    {options.length > 1 ? options.map(o => <Pressable key={o.language} onPress={() => choose(o.language)} accessibilityRole="button" accessibilityState={{ selected: o.language === current.language }} testID={`layover-phrase-language-${o.language}`}><Text>{o.languageName}</Text></Pressable>) : null}
    <Text>Phrases in {current.languageName}</Text>
    {current.phrases.map(p => <View key={p.key} testID={`layover-cached-plan-phrase-${p.key}`}><Text>{p.local}</Text><Text>{p.english}</Text></View>)}
    {current.stops.map((s, i) => <View key={`${i}:${s.stopTitle}`}><Text>{s.stopTitle}</Text>{s.phrases.map(p => <View key={p.key} testID={`layover-stop-phrase-${i}-${p.key}`}><Text>{p.local}</Text><Text>{p.english}</Text></View>)}</View>)}
    <Text>Place names are unchanged. Native-speaker review is pending.</Text>
  </View>;
}
