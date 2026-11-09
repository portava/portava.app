import { postLocalBinary, LocalMediaReadError } from '../postLocalBinary.ts';

// NOTE: Expo's native filesystem boundary is controlled; the transport selects, stages, sends and cleans the actual options.
const mockInfo = jest.fn();
const mockTask = jest.fn();
const mockCopy = jest.fn();
const mockDelete = jest.fn();
// NOTE: expose only the legacy native filesystem operations so the test can inspect the exact staged file and upload options.
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', FileSystemUploadType: { BINARY_CONTENT: 0 },
  FileSystemSessionType: { FOREGROUND: 1 }, getInfoAsync: (...a: unknown[]) => mockInfo(...a), copyAsync: (...a: unknown[]) => mockCopy(...a),
  deleteAsync: (...a: unknown[]) => mockDelete(...a), createUploadTask: (...a: unknown[]) => mockTask(...a) }));
const nativeResponse = { status: 201, body: '{"url":"post-media/u/v.mov","durationSeconds":8}' };
const originalFetch = globalThis.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = jest.fn();
  mockInfo.mockResolvedValue({ exists: true, isDirectory: false, size: 100 });
  mockTask.mockReturnValue({ uploadAsync: async () => nativeResponse, cancelAsync: jest.fn() });
  mockDelete.mockResolvedValue(undefined);
});
afterEach(() => { globalThis.fetch = originalFetch; });
it('streams the original iPhone file to the authorized endpoint in a binary POST without creating a JS Blob', async () => {
 const headers = { Authorization: 'Bearer test', 'Content-Type': 'video/quicktime' };
 const result = await postLocalBinary('https://api.test/api/media/upload', 'file:///recording.mov', headers);
 expect(mockTask).toHaveBeenCalledWith('https://api.test/api/media/upload', 'file:///recording.mov',
   { httpMethod: 'POST', uploadType: 0, sessionType: 1, headers });
 expect(globalThis.fetch).not.toHaveBeenCalled();
 expect(await result.json()).toMatchObject({ durationSeconds: 8 });
 expect(mockDelete).not.toHaveBeenCalled();
});
it('copies content-provider files to a private temporary file and removes only that copy', async () => {
 await postLocalBinary('https://api.test/api/media/upload', 'content://library/42', {});
 const copied = mockCopy.mock.calls[0][0];
 expect(copied.from).toBe('content://library/42'); expect(copied.to).toMatch(/^file:\/\/\/cache\/portava-upload-/);
 expect(mockTask.mock.calls[0][1]).toBe(copied.to);
 expect(mockDelete).toHaveBeenCalledWith(copied.to, { idempotent: true });
});
it('never sends a missing file or a file prepared after the account changed', async () => {
 mockInfo.mockResolvedValueOnce({ exists: false });
 await expect(postLocalBinary('https://api.test/api/media/upload', 'file:///missing', {})).rejects.toBeInstanceOf(LocalMediaReadError);
 let current = true;
 mockInfo.mockImplementationOnce(async () => { current = false; return { exists: true, size: 10 }; });
 await expect(postLocalBinary('https://api.test/api/media/upload', 'file:///clip', {}, { isCurrent: () => current })).rejects.toThrow('cancelled');
 expect(mockTask).not.toHaveBeenCalled();
});
