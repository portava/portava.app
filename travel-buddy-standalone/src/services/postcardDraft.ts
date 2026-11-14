import type { PostcardVisibility } from './postcards.ts';
import type { Place } from '../lib/location/placeTypes.ts';
import type { StampOverlayDraft } from '../lib/stampOverlay.ts';
export interface PostcardDraftAsset {
    uri: string;
    recoveryUri?: string;
    mimeType: string;
    fileName: string;
    fileSizeBytes: number;
    width?: number;
    height?: number;
    durationSeconds?: number;
    isVideo: boolean;
}
export interface PostcardDraft {
    uploadJobId?: string;
    caption: string;
    asset: PostcardDraftAsset | null;
    place: Place | null;
    visibility: PostcardVisibility;
    stampOverlay: StampOverlayDraft | null;
}
export function isPostcardDraft(value: unknown): value is PostcardDraft {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const d = value as PostcardDraft;
    return typeof d.caption === 'string' && d.caption.length <= 2000 && ['public', 'private', 'trip_only'].includes(d.visibility) &&
        (d.asset === null || !!d.asset && typeof d.asset.uri === 'string' && typeof d.asset.mimeType === 'string' && typeof d.asset.isVideo === 'boolean') &&
        (d.place === null || !!d.place && typeof d.place === 'object') && (d.stampOverlay === null || !!d.stampOverlay && typeof d.stampOverlay === 'object');
}
export const postcardDraftNonempty = (value: PostcardDraft) => !!value.caption.trim() || !!value.asset;
