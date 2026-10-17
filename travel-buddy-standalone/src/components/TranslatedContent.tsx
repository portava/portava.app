import React from 'react';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import { useContentTranslation } from '../hooks/useContentTranslation.ts';
import type { ContentEntityType, TranslatedFields } from '../services/contentTranslation.ts';
import { TranslationToggle } from './TranslationToggle.tsx';

export interface TranslatedContentProps {
  entityType: ContentEntityType;
  entityId: string;
  field: keyof TranslatedFields;
  original: string;
  originalLanguage?: string | null;
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

export function TranslatedContent({ entityType, entityId, field, original, originalLanguage, children, style, numberOfLines }: TranslatedContentProps) {
  const translation = useContentTranslation({ entityType, entityId, originalLanguage,
    sourceRevision: original, resolveLanguageOnServer: true });
  const translated = translation.translatedFields[field];
  return <View>
    {translation.translated && typeof translated === 'string' && translated.length > 0
      ? <Text style={style} numberOfLines={numberOfLines}>{translated}</Text> : children}
    <TranslationToggle tx={translation} />
  </View>;
}
