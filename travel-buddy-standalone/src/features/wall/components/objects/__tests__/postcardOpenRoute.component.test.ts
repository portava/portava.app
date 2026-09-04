/**
 * Wall postcard open → canonical Postcard viewer (Wall spec §10/§24).
 *
 * Opening a Postcard from the feed must land in /postcard/<id>, NOT the plain
 * post detail — the story presentation is preserved through the open. Every
 * other object type keeps its own canonical destination.
 */

import { resolveActionRoute } from '../wallItemShared.tsx';
import type {
  PostcardProjection,
  SocialPostProjection,
  WallAction,
} from '../../../types/wallProjection.ts';

const open: WallAction = { type: 'open_object', label: 'Open Postcard' };

function postcard(id: string): PostcardProjection {
  return {
    projectionId: `wall_postcard_${id}`,
    objectType: 'postcard',
    canonicalObjectId: id,
    publishedAt: '2026-08-31T20:42:00.000Z',
    visibility: 'public',
    storyPresentation: true,
    actions: [open],
  };
}

function post(id: string): SocialPostProjection {
  return {
    projectionId: `wall_social_post_${id}`,
    objectType: 'social_post',
    canonicalObjectId: id,
    publishedAt: '2026-08-31T20:42:00.000Z',
    visibility: 'public',
    actions: [open],
  };
}

it('routes a Postcard open to the canonical Postcard viewer', () => {
  expect(resolveActionRoute(open, postcard('pc-9'))).toBe('/postcard/pc-9');
});

it('still routes a plain post open to the post detail', () => {
  expect(resolveActionRoute(open, post('p-3'))).toBe('/post/p-3');
});
