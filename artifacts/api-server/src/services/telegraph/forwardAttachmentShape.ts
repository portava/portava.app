import { parseKindEnvelope } from './messageKinds.js';
import type { ForwardSource } from './forwarding.js';
export type ForwardAttachment = { url: string; mediaType: 'image' | 'video' };
export function forwardAttachmentsOf(source: ForwardSource): ForwardAttachment[] | null {
  if (source.msg_type?.toLowerCase() === 'media_album') {
    const envelope = parseKindEnvelope(source.msg_type, source.body);
    if (envelope?.kind !== 'MEDIA_ALBUM') return null;
    return (envelope.payload as { assets: ForwardAttachment[] }).assets.map(({url,mediaType})=>({url,mediaType}));
  }
  if (['media','image','video'].includes(source.msg_type?.toLowerCase() ?? '') && source.media_url && ['image','video'].includes(source.media_type ?? '')) {
    return [{url:source.media_url,mediaType:source.media_type as 'image'|'video'}];
  }
  return null;
}
