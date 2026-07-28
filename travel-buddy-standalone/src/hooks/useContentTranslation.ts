/**
 * useContentTranslation
 *
 * Manages on-demand translation state for a single piece of content.
 *
 * Usage:
 *   const tx = useContentTranslation({
 *     entityType: 'post',
 *     entityId: post.id,
 *     originalLanguage: post.originalLanguage,    // ISO code from API
 *   });
 *
 *   // Render translated or original text:
 *   const displayText = tx.translated ? tx.translatedText : originalText;
 *
 *   // Render the toggle:
 *   <TranslationToggle tx={tx} />
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguagePreference } from '../context/LanguagePreferenceContext.tsx';
import {
  fetchContentTranslation,
  type ContentEntityType,
  type TranslatedFields,
} from '../services/contentTranslation.ts';

export interface ContentTranslationState {
  /** True when viewer has a translation available AND is showing it. */
  translated: boolean;
  /** True while fetching the translation for the first time. */
  loading: boolean;
  /** Translated field values (populated once translated=true and fetch succeeded). */
  translatedFields: TranslatedFields;
  /** e.g. "Translated from Spanish" — shown as the label. */
  translationLabel: string;
  /** True when the source language differs from the viewer's preferred language and
   *  a translation is (or can be) shown. Controls toggle visibility. */
  canTranslate: boolean;
  /** Toggle between translated and original view. */
  toggle: () => void;
}

interface UseContentTranslationOptions {
  entityType: ContentEntityType;
  entityId: string;
  /** ISO 639-1 source language detected at write time, or null if unknown. */
  originalLanguage: string | null | undefined;
}

export function useContentTranslation({
  entityType,
  entityId,
  originalLanguage,
}: UseContentTranslationOptions): ContentTranslationState {
  const { preferredLanguage } = useLanguagePreference();
  const [translated, setTranslated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [translatedFields, setTranslatedFields] = useState<TranslatedFields>({});
  const [translationLabel, setTranslationLabel] = useState('');
  const fetchedForLang = useRef<string | null>(null);

  // Whether this content is in a different language than the viewer's preference.
  const canTranslate = Boolean(
    originalLanguage &&
    preferredLanguage &&
    originalLanguage !== preferredLanguage,
  );

  // Auto-fetch when the viewer has a preferred language that differs from the source.
  useEffect(() => {
    if (!canTranslate || !preferredLanguage) return;
    if (fetchedForLang.current === preferredLanguage) return;

    let cancelled = false;
    setLoading(true);

    fetchContentTranslation(entityType, entityId, preferredLanguage).then((result) => {
      if (cancelled) return;
      fetchedForLang.current = preferredLanguage;
      setLoading(false);

      if (result.ok && result.status === 'translated' && result.translatedFields) {
        setTranslatedFields(result.translatedFields);
        setTranslationLabel(result.translationLabel ?? '');
        setTranslated(true);
      }
    });

    return () => { cancelled = true; };
  }, [canTranslate, entityType, entityId, preferredLanguage]);

  const toggle = useCallback(() => {
    setTranslated((prev) => !prev);
  }, []);

  return { translated, loading, translatedFields, translationLabel, canTranslate, toggle };
}
