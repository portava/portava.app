import { jest, beforeEach, afterEach } from '@jest/globals';
import { cleanup } from '@testing-library/react-native';
/** Real owner observer + queue/pipeline; only SDK, native disk and HTTP effects
 * are boundaries. Old uploader assertions continue to inspect their requests. */
jest.mock('../../lib/supabase.ts', () => {
    const listeners = new Set();
    return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
// NOTE: intentionally exhaustive session boundary for the two composer families.
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: 'draft-owner', signOut: jest.fn() }) }));
// NOTE: native/browser filesystem boundary; real draft store remains under test.
jest.mock('../../services/composerDraftAsset.ts', () => ({ preserveDraftAsset: jest.fn(async (uri: string) => uri), restoreDraftAsset: async (uri: string) => uri, discardDraftAsset: jest.fn(async () => { }), releaseDraftPreview: () => {} }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { seedObservedOwnerSession, disposeObservedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
import { _setPostcardUploadQueue, PostcardUploadQueue } from '../../services/media/postcardUploadQueue.ts';
let sequence = 0;
beforeEach(async () => {
    await AsyncStorage.clear();
    setDiscoveryViewerFromSession('draft-owner');
    seedObservedOwnerSession('draft-owner', 'draft-session');
    const cards = () => require('../../services/postcards.ts');
    const http = () => require('../../services/media/uploadHttp.ts');
    _setPostcardUploadQueue(new PostcardUploadQueue({
        storage: AsyncStorage, accountId: async () => 'draft-owner', newId: () => `fixture-job-${++sequence}`, now: Date.now,
        deps: async () => ({
            createShell: input => cards().createPostcard({ caption: input.caption, visibility: input.visibility, ...input.location, addToPassport: input.addToPassport }),
            reserveSlot: (postId, params) => cards().getUploadUrl(postId, params),
            readFile: async (uri) => ({ uri, size: (await http().readFileBlob(uri)).size, slice: () => new Uint8Array(1) }),
            resumable: { enabled: false, transport: { api: async () => ({ status: 404, body: null, retryAfter: null }), putPart: async () => ({ status: 200, retryAfter: null }) } },
            putWhole: (url, file, mime, progress) => cards().uploadToSignedUrl(url, (file as any).uri, mime, progress, {}),
            extractPoster: async (uri) => uri, uploadPoster: (post, media, uri) => http().uploadVideoPoster(post, media, uri),
            complete: (post, media, params) => cards().completeUpload(post, media, params), publish: async () => ({ ok: true, data: {} }),
            discardShell: async (post) => cards().discardPostcardShell?.(post), now: Date.now, env: { sleep: async () => { }, random: () => 0 },
        })
    }));
});
afterEach(async () => { await cleanup(); disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); _setPostcardUploadQueue(null); });
