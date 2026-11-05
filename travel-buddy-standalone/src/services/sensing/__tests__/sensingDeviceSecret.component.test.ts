let mockStored: string | null = null;
const mockWrite = jest.fn(async (_key: string, value: string) => { mockStored = value; });
// NOTE: exhaustive private storage boundary; the actual keychain is never accessed.
jest.mock('../../../lib/secureStore.ts', () => ({ SECURE_KEYS: { SENSING_DEVICE_SECRET: 'test-key' }, getSecure: async () => mockStored, setSecure: (...args: [string, string]) => mockWrite(...args) }));
import { sensingDeviceSecret, readExistingSensingDeviceSecret, rotateSensingDeviceSecret, _resetSensingDeviceSecret } from '../sensingDeviceSecret.ts';
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
beforeEach(() => {
  mockStored = null; _resetSensingDeviceSecret(); mockWrite.mockClear(); mockWrite.mockImplementation(async (_key, value) => { mockStored = value; });
  let seed = 0; Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes: Uint8Array) => bytes.fill(++seed) } });
});
afterAll(() => { if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); });
it('concurrent first contributions share one durable secret', async () => {
  const values = await Promise.all([sensingDeviceSecret(), sensingDeviceSecret(), sensingDeviceSecret()]);
  expect(new Set(values).size).toBe(1); expect(values[0]).toMatch(/^[0-9a-f]{64}$/); expect(values[0]).toBe(mockStored); expect(mockWrite).toHaveBeenCalledTimes(1);
});
it('does not create proof material when merely checking for contributions', async () => { expect(await readExistingSensingDeviceSecret()).toBeNull(); expect(mockWrite).not.toHaveBeenCalled(); });
it('refuses contributions when storage silently drops the secret', async () => { mockWrite.mockImplementation(async () => {}); expect(await sensingDeviceSecret()).toBeNull(); });
it('rotation changes and persists the commitment root', async () => {
  const previous = await sensingDeviceSecret(); expect(await rotateSensingDeviceSecret()).toBe(true); const next = await sensingDeviceSecret(); expect(next).not.toBe(previous); expect(next).toBe(mockStored);
});
