---
name: Follow backend API shape
description: Shape of all follow/profile endpoints registered in the API server — needed when wiring frontend
---

Endpoints registered in `artifacts/api-server/src/routes/follows.ts` (mounted via index.ts):

POST   /api/users/:userId/follow        → { following: true, userId }
DELETE /api/users/:userId/follow        → { following: false, userId }
GET    /api/users/:userId/follow-status → { userId, isFollowing, followersCount, followingCount }
GET    /api/me/following                → { users: [{ id, handle, name, avatarUrl, since }] }
GET    /api/me/followers                → { users: [{ id, handle, name, avatarUrl, since }] }
GET    /api/users/:userId               → full public passport profile (see below)

GET /api/users/:userId response shape:
  id, handle, name, avatarUrl, bio, homeCity, homeCountry, currentCity,
  travelStyle, interests, verified, openToMeet, isPrivate, memberSince,
  followersCount, followingCount, isFollowing, isOwnProfile

Auth: follow/unfollow/status/lists = required. GET /users/:userId = optional (isFollowing=false if unauthed).

**Why:** Decision layer (followDecisions.ts) is pure/testable; route layer calls DB. FK is on profiles (not auth.users).
**How to apply:** Frontend Task wiring follow UI on Passport page should use GET /api/users/:userId as the single "load passport" call, then POST/DELETE /api/users/:userId/follow for toggle.
