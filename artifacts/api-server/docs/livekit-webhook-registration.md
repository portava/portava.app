# LiveKit Cloud Webhook Registration

## Why this matters

The API server's `POST /api/calls/webhook` endpoint reconciles LiveKit room events
(room created/finished, participant joined/left) with the call-session database. Without
the webhook registered, ghost-call self-healing still works via the periodic sweep, but
`room_finished` events never arrive in real time — ended calls stay in `ringing` or
`active` state until the next sweep runs (up to 5 minutes).

---

## Pre-requisites

- The API server must be **republished** so the route is live.
  Verify: `curl -s -o /dev/null -w "%{http_code}" -X POST https://portava.replit.app/api/calls/webhook -H "Content-Type: application/json" -d '{}'`  
  Expected: **401** (not 404 — 404 means the deployment is stale).

- The LiveKit credentials in project secrets must match the ones on the LiveKit Cloud project:
  `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

---

## Step 1 — Open the LiveKit Cloud dashboard

Go to [cloud.livekit.io](https://cloud.livekit.io) and sign in.

Select the project whose API key matches `LIVEKIT_API_KEY` in the project secrets.

---

## Step 2 — Register the webhook URL

1. In the left sidebar choose **Settings → Webhooks** (sometimes under **Project Settings**).
2. Click **Add Webhook** (or **New Endpoint**).
3. Enter the URL:
   ```
   https://portava.replit.app/api/calls/webhook
   ```
4. Leave the signing key as **the project's default API key**. LiveKit signs webhook
   payloads with the same key pair used for tokens — no separate secret is needed.
5. Select event types to receive. At minimum enable:
   - `room_finished`
   - `participant_joined`
   - `participant_left`
   Optionally also enable `room_started` for analytics (the handler is a no-op for
   unrecognised events, so enabling extra types is safe).
6. Save / Create.

---

## Step 3 — Verify with the round-trip script

From the workspace root, run:

```sh
node artifacts/api-server/scripts/verify-prod-webhook.mjs
```

Expected output:

```
=== Production webhook verification ===

  ✓ Unsigned POST → 401 (route is live)
  ✓ Self-signed POST → 200 (signature verification works)
  ✓ Tampered body → 401 (replay protection works)

--- Step 4: Real LiveKit round-trip (requires dashboard registration) ---
  ✓ Create + delete throwaway room "pcall_verify_xxxxxx" → LiveKit sends webhook → check prod logs

=== Results: 4 passed, 0 failed ===
```

If step 4 passes, check production deployment logs for a line like:

```
event=room_finished room=pcall_verify_xxxxxx
```

That confirms LiveKit successfully delivered the event and the handler reconciled it (200 OK).

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Step 1 returns 404 | Deployment is stale — republish the API server first |
| Step 2 returns 401 | Signature mismatch — confirm `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in secrets match the LiveKit Cloud project |
| Step 4 hangs or fails | Webhook not yet registered, or wrong URL registered in the dashboard |
| Production logs show 401 on webhook delivery | LiveKit is using a different API key than what the handler expects — check the key selected in the dashboard |

---

## Idempotency note

The webhook handler is intentionally safe for unknown room names. A `room_finished`
event for a room not in the database is logged and silently dropped — no error is
returned. Re-deliveries are also safe (reconciler checks current state before writing).
