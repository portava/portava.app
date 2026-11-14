/** Closed event vocabulary. Deliberately no draft/post/recipient IDs, text,
 * lengths, media data, filenames, URLs, coordinates or exception messages. */
export const COMPOSER_OUTCOMES = ['left_with_unsent', 'discarded_draft', 'upload_cancelled', 'upload_failed', 'post_discarded_after_upload', 'published'] as const;
export const COMPOSER_SURFACES = ['comment_sheet', 'comment_inline', 'postcard', 'post'] as const;
export const COMPOSER_FAILURE_CODES = ['network', 'storage', 'unsupported_media', 'rejected', 'unknown'] as const;
export type ComposerOutcome = typeof COMPOSER_OUTCOMES[number];
export type ComposerSurface = typeof COMPOSER_SURFACES[number];
export type ComposerFailureCode = typeof COMPOSER_FAILURE_CODES[number];
export interface ComposerOutcomeEvent {
    event_id: string;
    version: 1;
    surface: ComposerSurface;
    outcome: ComposerOutcome;
    failure_code?: ComposerFailureCode;
}
export function isComposerOutcomeEvent(input: unknown): input is ComposerOutcomeEvent {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return false;
    const event = input as ComposerOutcomeEvent;
    return Object.keys(event).every(key => ['event_id', 'version', 'surface', 'outcome', 'failure_code'].includes(key)) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.event_id) && event.version === 1 &&
        (COMPOSER_SURFACES as readonly string[]).includes(event.surface) && (COMPOSER_OUTCOMES as readonly string[]).includes(event.outcome) &&
        (event.failure_code === undefined || event.outcome === 'upload_failed' && (COMPOSER_FAILURE_CODES as readonly string[]).includes(event.failure_code));
}
