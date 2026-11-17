import type { PickedMedia } from './media.ts';
import type { Place } from '../lib/location/placeTypes.ts';
import type { PostCategory } from '../types/models.ts';
import type { LocationPrivacyMode, PostVisibility } from './posts.ts';
export interface PostComposerDraft {
    selectedType: string | null;
    selectedCategory: PostCategory | null;
    text: string;
    placeName: string;
    media: PickedMedia | null;
    vis: PostVisibility;
    selectedPlace: Place | null;
    addToPassport: boolean;
    filterId: string;
    filterIntensity: number;
    locationPrivacyMode: LocationPrivacyMode;
    scheduledTime: string | null;
    uploadOperation?: string;
    uploadCompleted?: boolean;
    uploadedMedia?: {
        url: string;
        thumbnailUrl?: string | null;
        mediaType?: string;
    };
    publicationOperation?: string;
}
export function isPostComposerDraft(value: unknown): value is PostComposerDraft {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const d = value as PostComposerDraft;
    return typeof d.text === 'string' && d.text.length <= 5000 && typeof d.placeName === 'string' &&
        (d.selectedType === null || ['post_update', 'ask_question', 'share_moment', 'share_postcard', 'share_hidden_gem', 'share_food_spot', 'share_highlight'].includes(d.selectedType)) && (d.selectedCategory === null || ['hotel', 'food', 'nightlife', 'beach', 'activity', 'transport', 'airport', 'visa', 'safety', 'tip', 'question'].includes(d.selectedCategory)) &&
        ['public', 'private', 'trip_only'].includes(d.vis) && typeof d.addToPassport === 'boolean' && typeof d.filterId === 'string' && Number.isFinite(d.filterIntensity) && d.filterIntensity >= 0 && d.filterIntensity <= 100 &&
        (d.uploadedMedia === undefined || !!d.uploadedMedia && typeof d.uploadedMedia.url === 'string' && d.uploadedMedia.url.startsWith('post-media/')) &&
        (d.media === null || !!d.media && typeof d.media.uri === 'string' && ['image', 'video'].includes(d.media.type ?? '') && typeof d.media.mimeType === 'string') && (d.selectedPlace === null || !!d.selectedPlace && typeof d.selectedPlace === 'object') &&
        ['none', 'hidden', 'city_only', 'delayed_until_exit', 'delayed_until_time', 'trusted_circle_only', 'neighborhood_only'].includes(d.locationPrivacyMode) && (d.scheduledTime === null || typeof d.scheduledTime === 'string' && Number.isFinite(Date.parse(d.scheduledTime)));
}
export const postComposerNonempty = (d: PostComposerDraft) => !!d.text.trim() || !!d.media || !!d.placeName.trim();
