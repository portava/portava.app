import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupFsqPhoto } from '../fsqPhotoLookup.ts';
import { lookupGooglePhoto } from '../googlePhotoLookup.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const [provider, lookup] of [['foursquare', lookupFsqPhoto], ['google', lookupGooglePhoto]] as const) {
  describe(`${provider} cache preserves place identity`, () => {
    it('does not reuse a photo between same-name adjacent branches or different IDs', async () => {
      const requests: URL[] = [];
      globalThis.fetch = (async input => {
        requests.push(new URL(String(input), 'https://test.invalid'));
        return { ok: true, json: async () => ({ photoUrl: `https://test.invalid/${requests.length}.jpg` }) } as Response;
      }) as typeof fetch;
      const name = `Identity fixture ${provider}`;
      const first = await lookup(name, 16.07381, 108.2183, 'node/2704');
      const adjacent = await lookup(name, 16.07382, 108.2183, 'node/2704');
      const otherId = await lookup(name, 16.07382, 108.2183, 'node/2705');
      assert.notEqual(first, adjacent);
      assert.notEqual(adjacent, otherId);
      assert.equal(requests.length, 3);
      assert.equal(await lookup(name, 16.07381, 108.2183, 'node/2704'), first);
      assert.equal(requests.length, 3, 'an identical request still reuses its verified cache');
    });
  });
}
