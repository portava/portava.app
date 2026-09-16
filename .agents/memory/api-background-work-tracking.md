---
name: Deterministic API background work
description: The project convention for non-blocking API side effects that tests must await without timing sleeps.
---

API request handlers must keep background side effects non-blocking in production, while tests explicitly enable a scoped tracking session and await the real completion signal.

**Why:** Fixed sleeps remained flaky under concurrent load, and a process-global tracker allowed late failures from one test to contaminate another. Swallowed rejections also let tests pass when writes failed.

**How to apply:** Wrap route/service fire-and-forget promises with the shared tracker. In tests, enable a fresh session, await completion before asserting dependent writes, then disable it. Tracker failure handling must never throw while logging, and batch jobs should attempt independent items before raising aggregated failures.