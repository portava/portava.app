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
import { useCallback, useEffect, useState } from 'react';
import { useLanguagePreference } from '../context/LanguagePreferenceContext.tsx';
import { useSession } from '../context/SessionContext.tsx';
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
  sourceRevision?: string;
  resolveLanguageOnServer?: boolean;
}

export function useContentTranslation({
  entityType,
  entityId,
  originalLanguage,
  sourceRevision,
  resolveLanguageOnServer = false,
}: UseContentTranslationOptions): ContentTranslationState {
  const { preferredLanguage, preferenceSession } = useLanguagePreference();
  const { userId } = useSession();
  const key = JSON.stringify([userId, preferenceSession, entityType, entityId, originalLanguage, preferredLanguage, sourceRevision, resolveLanguageOnServer]);
  const [state, setState] = useState({ key: '', translated: false, loading: false,
    translatedFields: {} as TranslatedFields, translationLabel: '' });

  // Whether this content is in a different language than the viewer's preference.
  const canTranslate = Boolean(
    userId && (originalLanguage || resolveLanguageOnServer) &&
    preferredLanguage &&
    originalLanguage !== preferredLanguage,
  );

  // Auto-fetch when the viewer has a preferred language that differs from the source.
  useEffect(() => {
    setState({ key, translated: false, loading: canTranslate, translatedFields: {}, translationLabel: '' });
    if (!canTranslate || !preferredLanguage) return;

    let cancelled = false;

    fetchContentTranslation(entityType, entityId, preferredLanguage).then((result) => {
      if (cancelled) return;
      const available = Boolean(result.ok && result.status === 'translated' && result.translatedFields
        && Object.keys(result.translatedFields).length);
      setState({ key, loading: false, translated: available,
        translatedFields: available ? result.translatedFields! : {},
        translationLabel: available ? result.translationLabel ?? '' : '' });
    }).catch(() => {
      if (!cancelled) setState({ key, translated: false, loading: false, translatedFields: {}, translationLabel: '' });
    });

    return () => { cancelled = true; };
  }, [key, canTranslate, entityType, entityId, preferredLanguage]);

  const toggle = useCallback(() => {
    setState(previous => previous.key === key && Object.keys(previous.translatedFields).length
      ? { ...previous, translated: !previous.translated } : previous);
  }, [key]);

  const current = state.key === key ? state : { translated: false, loading: canTranslate, translatedFields: {}, translationLabel: '' };
  return { ...current, canTranslate: canTranslate && (current.loading || Object.keys(current.translatedFields).length > 0), toggle };
}
