/**
 * PlaceCategoryFallback — maps a place category string to a visual fallback
 * descriptor used by MediaFallback when no real image is available.
 *
 * This is the single source-of-truth for category fallback art across all
 * place surfaces (discovery cards, detail cards, map previews, sheets).
 */

export interface CategoryFallbackDescriptor {
  /** Emoji icon rendered in the fallback area. */
  emoji: string;
  /** Human-readable label shown below the emoji. */
  label: string;
  /** Hex accent colour used for the fallback background tint. */
  color: string;
}

const FALLBACKS: Record<string, CategoryFallbackDescriptor> = {
  food:        { emoji: '🍽️',  label: 'Food & Dining',  color: '#D4722A' },
  nightlife:   { emoji: '🎵',  label: 'Nightlife',       color: '#7C3AED' },
  activities:  { emoji: '🏄',  label: 'Activities',      color: '#2E7D5B' },
  events:      { emoji: '🎉',  label: 'Events',          color: '#B45309' },
  beaches:     { emoji: '🏖️', label: 'Beach',            color: '#0891B2' },
  transport:   { emoji: '🚌',  label: 'Transport',       color: '#475569' },
  places:      { emoji: '🏛️', label: 'Places',           color: '#0A6EBD' },
  for_you:     { emoji: '✨',  label: 'For You',         color: '#FF6B6B' },
  arts:        { emoji: '🎨',  label: 'Arts & Culture',  color: '#9333EA' },
  outdoors:    { emoji: '🌲',  label: 'Outdoors',        color: '#16A34A' },
  shopping:    { emoji: '🛍️', label: 'Shopping',         color: '#0369A1' },
  services:    { emoji: '⚙️',  label: 'Services',        color: '#4B5563' },
  health:      { emoji: '💊',  label: 'Health',          color: '#DC2626' },
  lodging:     { emoji: '🏨',  label: 'Lodging',         color: '#B45309' },
  parks:       { emoji: '🌳',  label: 'Park',            color: '#15803D' },
  museums:     { emoji: '🏺',  label: 'Museum',          color: '#6D28D9' },
  landmarks:   { emoji: '🗿',  label: 'Landmark',        color: '#1D4ED8' },
};

const DEFAULT: CategoryFallbackDescriptor = {
  emoji: '📍',
  label: 'Place',
  color: '#6B7280',
};

/**
 * Returns the visual fallback descriptor for a given category string.
 * Always returns a valid descriptor — never throws or returns null.
 */
export function getPlaceCategoryFallback(category: string): CategoryFallbackDescriptor {
  return FALLBACKS[category?.toLowerCase?.()] ?? DEFAULT;
}
