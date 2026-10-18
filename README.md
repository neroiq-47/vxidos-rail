# VXIDOS Rail v1.0

An approval-first content rail for **VXIDOS** (`@vxidphantom_`), with the tagline *no face. just vision.* It drafts on-brand X posts with an LLM. A human reviews and edits each one in a small web dashboard. Only approved posts can be sent to Buffer, and they arrive there as **Buffer drafts**, so nothing is ever auto-published.

```
generate ──▶ pending_approval ──▶ approved ──▶ queuing ──▶ queued (Buffer draft)
                  │   ▲ edit          │            └─ fail ─▶ approved (+queueError)
                  └─▶ rejected        └─ (manual only)
```

## Quick start
Requires Node.js 20+.
```bash
npm install
cp .env.example .env      # set OPENAI_API_KEY and RAIL_SECRET (≥24 chars: openssl rand -hex 24)
npm test
npm start                 # open http://127.0.0.1:3000 and sign in with RAIL_SECRET
npm run draft -- 3        # or generate 3 drafts from the CLI
```

### Docker
```bash
docker build -t vxidos-rail .
docker run -p 127.0.0.1:3000:3000 --env-file .env -v vxidos-data:/data vxidos-rail
```

## Features
- **Review dashboard** at `/`, with no build step and a strict CSP. Edit drafts inline, approve or reject them (with an optional note), push approved ones to Buffer, and view the audit trail.
- **Generation with guardrails**:
  - Pillar rotation: midnight lifestyle, phantom identity, digital-building progress.
  - Recent posts are included in the prompt so it avoids repeats.
  - Output that fails validation (links, unverifiable financial claims, mass mentions, hashtag spam, outside 12–280 Unicode characters) is retried up to 3 times.
  - Near-duplicate blocking: case, punctuation and spacing are normalised before hashing.
- **Audited store**: a transactional JSON file with an in-process queue, a cross-process lock file, recovery of stale locks after a crash, and an append-only event log (capped at 5,000 events).
- **Buffer integration**, verified against the examples on developers.buffer.com:
  - Uses `createPost(input:{…, saveToDraft: true})`.
  - Each push is claimed first, so two concurrent clicks can't double-post.
  - A failed push returns the draft to `approved` with the error recorded.
- **Security**:
  - Bearer-token auth compared as SHA-256 digests in constant time.
  - An IP is locked out after N failed attempts, even if it later sends the correct token.
  - Per-IP request and generation rate limits.
  - 8 KB body cap and security headers.
  - Binds to localhost by default.
- **Autopilot (optional)**: `DRAFT_INTERVAL_MINUTES` creates a pending draft on a timer and stops at `MAX_PENDING_DRAFTS`. It still needs human approval.
- CI on GitHub Actions (Node 20 and 22) and a Dockerfile that runs as a non-root user.

## Connecting Buffer
1. Create an API key at <https://publish.buffer.com/settings/api> and set `BUFFER_API_KEY`.
2. `GET /buffer/check` lists your organizations. `GET /buffer/channels` lists their channels, with `service` showing the network (e.g. X).
3. Set `BUFFER_CHANNEL_ID` and, optionally, `BUFFER_ORGANIZATION_ID`.
4. Set `BUFFER_WRITES_ENABLED=true` and restart. The dashboard's **send to buffer** button becomes active.

Drafts land in Buffer with status `draft`. Schedule them from Buffer.

## API
All endpoints except `/`, `/ui.*` and `/health` need `Authorization: Bearer $RAIL_SECRET`. Errors return `{"error": "..."}`.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/health` | | `{ok, version, bufferWrites}` |
| GET | `/stats` | | counts per status |
| GET | `/drafts` | `?status=pending_approval\|approved\|rejected\|queuing\|queued` | newest first |
| GET | `/drafts/:id` | | |
| POST | `/draft` | `{count?: 1-5, pillar?}` | calls the LLM (costs money); `201 {drafts, errors}` |
| PATCH | `/drafts/:id` | `{text, editor}` | pending only; logs the previous text |
| POST | `/drafts/:id/review` | `{decision: "approved"\|"rejected", reviewer, note?}` | |
| POST | `/drafts/:id/queue` | `{reviewer}` | approved only; needs Buffer writes enabled |
| GET | `/events` | `?limit=50` | audit log, newest first |
| GET | `/buffer/check`, `/buffer/channels` | | read-only |

Status codes: `400` invalid input, `401`/`429` auth, `404`, `409` wrong state or duplicate, `413` body too large, `502` upstream (OpenAI/Buffer) failure, `503` missing configuration or storage busy.

## Operational limits
- The JSON store is built for **one process on a persistent disk**. Running several instances needs Postgres or Supabase with unique constraints on `hash` and transactional status updates. The `store.js` API is small enough to swap out.
- Auth is a single shared token. Anyone holding it can review, and the `reviewer` name is self-declared. For teams, put an SSO proxy in front (e.g. Cloudflare Access) and derive the reviewer from it.
- Rate limits are in memory and reset when the process restarts.
- Don't expose the server publicly without TLS and an authenticated proxy.
- A draft stuck in `queuing` (from a crash mid-push) becomes claimable again after 10 minutes. Check Buffer for a duplicate before retrying.
