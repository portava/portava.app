/**
 * census H98 — the client side of a §4 PERMANENT Highlight (`expires_at` NULL,
 * migration 2975). Two readers assumed the value was a timestamp:
 *   - the viewer's time-left label read NULL as the epoch: "0m left";
 *   - the viewed-ring store never persisted a NULL expiry, so a permanent
 *     Highlight's ring came back unread on every restart.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { highlightExpiryLabel, PERMANENT_HIGHLIGHT_LABEL } from '../highlightExpiryLabel.ts';
import {
  markViewed,
  viewedHighlightIds,
  initViewedIds,
  keepViewedEntry,
  PERMANENT_VIEWED_MARK,
  _resetHighlightViewedStateForTest,
  _resetMigratedHighlightViewedAccountIds,
  _setTestStorage,
} from '../../../services/highlightViewedStorage.ts';
import { _setTestAccountScopedStorageFlag } from '../../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../../../services/accountId.ts';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

describe('the time-left label', () => {
  it('a PERMANENT Highlight is labelled permanent, not "0m left"', () => {
    assert.equal(highlightExpiryLabel(null, NOW), PERMANENT_HIGHLIGHT_LABEL);
  });
  it('a timed Highlight keeps its countdown', () => {
    assert.equal(highlightExpiryLabel(new Date(NOW + 3 * 3600_000 + 60_000).toISOString(), NOW), '3h left');
    assert.equal(highlightExpiryLabel(new Date(NOW + 5 * 60_000).toISOString(), NOW), '5m left');
    assert.equal(highlightExpiryLabel(new Date(NOW - 60_000).toISOString(), NOW), '0m left');
  });
});

describe('the viewed ring remembers a PERMANENT Highlight', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    _setTestStorage({
      getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
      setItem: (k: string, v: string) => { store.set(k, v); return Promise.resolve(); },
      removeItem: (k: string) => { store.delete(k); return Promise.resolve(); },
    });
    _resetHighlightViewedStateForTest();
    _resetMigratedHighlightViewedAccountIds();
    _setTestAccountScopedStorageFlag(true);
    _setTestAccountId('user-a');
  });
  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
    _resetHighlightViewedStateForTest();
    _setTestStorage(null);
  });

  it('a NULL expiry is persisted under the permanent mark and survives a reload', async () => {
    await initViewedIds();
    markViewed('perm-1', null);
    await new Promise((r) => setTimeout(r, 0));
    const raw = [...store.values()].join('');
    assert.ok(raw.includes(`"perm-1":"${PERMANENT_VIEWED_MARK}"`), raw);
    _resetHighlightViewedStateForTest();
    await initViewedIds();
    assert.ok(viewedHighlightIds.has('perm-1'), 'still viewed after a restart');
  });

  it('the prune keeps the mark and future expiries, drops past ones and garbage', () => {
    assert.equal(keepViewedEntry(PERMANENT_VIEWED_MARK, NOW), true);
    assert.equal(keepViewedEntry(new Date(NOW + 1000).toISOString(), NOW), true);
    assert.equal(keepViewedEntry(new Date(NOW - 1000).toISOString(), NOW), false);
    assert.equal(keepViewedEntry('garbage', NOW), false);
  });

  it('an omitted expiry is still in-memory only (unchanged)', async () => {
    await initViewedIds();
    markViewed('timed-unknown');
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(viewedHighlightIds.has('timed-unknown'));
    assert.ok(![...store.values()].join('').includes('timed-unknown'));
  });
});
