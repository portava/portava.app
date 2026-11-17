import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLocalComposerAssets, localAssetCleanupKey } from './localComposerAssetCleanup.ts';
function fixture() {
  const values = new Map<string, string>();
  return { values, storage: { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => { values.set(key, value); }, removeItem: async (key: string) => { values.delete(key); } } };
}
test('local discard records its intent before bytes are removed and retries failed deletion after restart', async () => {
  const { values, storage } = fixture(); let attempts = 0;
  await assert.rejects(cleanLocalComposerAssets(storage, 'a', async () => { attempts++; assert.ok(values.has(localAssetCleanupKey('a'))); throw new Error('disk'); }, 'file:///owned/copy.jpg'));
  await cleanLocalComposerAssets(storage, 'a', async uri => { attempts++; assert.equal(uri, 'file:///owned/copy.jpg'); });
  await cleanLocalComposerAssets(storage, 'a', async () => { attempts++; });
  assert.equal(attempts, 2); assert.equal(values.size, 0);
});
test('local cleanup is account scoped and concurrent discard intents cannot overwrite each other', async () => {
  const { values, storage } = fixture(); const removed: string[] = [];
  values.set(localAssetCleanupKey('b'), JSON.stringify(['file:///b/retained.jpg']));
  await Promise.all(['one', 'two'].map(uri => cleanLocalComposerAssets(storage, 'a', async target => { removed.push(target); }, uri)));
  assert.deepEqual(removed.sort(), ['one', 'two']); assert.ok(values.has(localAssetCleanupKey('b')));
});
test('unreadable local cleanup intent is preserved instead of overwritten', async () => {
  const { values, storage } = fixture(); values.set(localAssetCleanupKey('a'), '{broken'); let removed = false;
  await assert.rejects(cleanLocalComposerAssets(storage, 'a', async () => { removed = true; }, 'new'));
  assert.equal(removed, false); assert.equal(values.get(localAssetCleanupKey('a')), '{broken');
});
