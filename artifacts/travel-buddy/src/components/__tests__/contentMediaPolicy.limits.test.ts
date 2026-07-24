/**
 * contentMediaPolicy — registry completeness and limit/flag tests.
 *
 * Pure logic: no React, no mocks. Runs in the node:test runner.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPolicy,
  policyAllowsVideo,
  CONTENT_MEDIA_POLICIES,
  type ContentPolicyKey,
} from '../../lib/contentMediaPolicy.ts';

const ALL_KEYS: ContentPolicyKey[] = [
  'pulse', 'story', 'highlight', 'postcard', 'memory',
  'profileAvatar', 'profileCover', 'message', 'event', 'trip',
  // Optional-photo flows added in Phase 0 Tasks 1–4
  'tripCover', 'review', 'buddyApplication', 'hiddenGem',
  // Defined for policy completeness; server endpoints have no media column (skipped flows)
  'communityPlace', 'safetyReport',
];

describe('contentMediaPolicy registry completeness', () => {
  it('all content-type keys are present in the registry', () => {
    for (const key of ALL_KEYS) {
      assert.ok(CONTENT_MEDIA_POLICIES[key] !== undefined, `Policy missing for key: ${key}`);
    }
  });

  it('every policy has required fields', () => {
    for (const key of ALL_KEYS) {
      const p = getPolicy(key);
      assert.equal(typeof p.maxItems, 'number', `${key}.maxItems must be a number`);
      assert.ok(p.maxItems > 0, `${key}.maxItems must be positive`);
      assert.ok(Array.isArray(p.allowedTypes), `${key}.allowedTypes must be an array`);
      assert.ok(p.allowedTypes.length > 0, `${key}.allowedTypes must not be empty`);
      assert.equal(typeof p.supportsCover, 'boolean', `${key}.supportsCover must be boolean`);
      assert.equal(typeof p.supportsGallery, 'boolean', `${key}.supportsGallery must be boolean`);
      assert.equal(typeof p.supportsAltText, 'boolean', `${key}.supportsAltText must be boolean`);
    }
  });
});

describe('contentMediaPolicy maxItems limits', () => {
  it('pulse maxItems is 1 — no gallery', () => {
    assert.equal(getPolicy('pulse').maxItems, 1);
    assert.equal(getPolicy('pulse').supportsGallery, false);
  });

  it('memory maxItems is 10 with full gallery + cover + altText support', () => {
    const p = getPolicy('memory');
    assert.equal(p.maxItems, 10);
    assert.equal(p.supportsGallery, true);
    assert.equal(p.supportsCover, true);
    assert.equal(p.supportsAltText, true);
  });

  it('trip maxItems is 20', () => {
    assert.equal(getPolicy('trip').maxItems, 20);
  });

  it('highlight maxItems is 1 with 10s video limit', () => {
    const p = getPolicy('highlight');
    assert.equal(p.maxItems, 1);
    assert.equal(p.videoMaxDuration, 10);
  });

  it('message maxItems is 1 with 60s video limit', () => {
    const p = getPolicy('message');
    assert.equal(p.maxItems, 1);
    assert.equal(p.videoMaxDuration, 60);
  });
});

describe('policyAllowsVideo helper', () => {
  it('returns true for policies with video support', () => {
    for (const key of ['pulse', 'story', 'highlight', 'postcard', 'memory', 'message', 'event', 'trip'] as ContentPolicyKey[]) {
      assert.equal(policyAllowsVideo(getPolicy(key)), true, `expected ${key} to allow video`);
    }
  });

  it('returns false for image-only policies', () => {
    assert.equal(policyAllowsVideo(getPolicy('profileAvatar')), false);
    assert.equal(policyAllowsVideo(getPolicy('profileCover')), false);
  });
});

describe('contentMediaPolicy flags consistency', () => {
  it('policies with supportsGallery=true also have supportsCover=true', () => {
    for (const key of ALL_KEYS) {
      const p = getPolicy(key);
      if (p.supportsGallery) {
        assert.equal(p.supportsCover, true, `${key}: supportsGallery=true but supportsCover=false`);
      }
    }
  });

  it('single-item policies (maxItems=1) have supportsGallery=false', () => {
    for (const key of ALL_KEYS) {
      const p = getPolicy(key);
      if (p.maxItems === 1) {
        assert.equal(p.supportsGallery, false, `${key}: maxItems=1 but supportsGallery=true`);
      }
    }
  });
});
