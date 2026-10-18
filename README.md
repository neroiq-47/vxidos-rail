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

### Railway
The repo's Dockerfile is used automatically.

| Setting | Value | Why |
|---|---|---|
| Variables | `RAIL_SECRET`, `OPENAI_API_KEY` | required (the app exits with a one-line log if `RAIL_SECRET` is missing) |
| | `TRUST_PROXY=x-real-ip` | Railway's edge sends the client IP in `X-Real-IP`; without this every visitor shares one IP, so a few bad logins lock everyone out |
| | `RAILWAY_RUN_UID=0` | the image runs as non-root, and Railway volumes need root to write |
| | `RAIL_DATA_PATH=/data/drafts.json` | store on the volume |
| Volume | mounted at `/data` | drafts and the audit log survive redeploys |
| Healthcheck | `/health`, 60s timeout | a deploy that never becomes healthy is marked failed |
| Replicas | **1** | Railway doesn't allow replicas with a volume, and the JSON store is single-process |
| Draining | 10s | in-flight requests finish after `SIGTERM` (the app force-exits after 8s) |
| Wait for CI | on (Settings → Source) | merges to `main` only deploy once GitHub Actions pass |
| Backups | on (volume → Backups) | the volume is the only copy of your drafts |

Railway logs are parsed as one JSON object per line, with a `level` field. With a volume there's a brief gap on each redeploy, because Railway won't mount the volume in two deployments at once. Railway's Config as Code files (`railway.json` / `railway.toml`) are deprecated and stop being read on 2026-12-01, so this repo doesn't ship one. To keep these settings in code, run `railway config pull` to generate `.railway/railway.ts` (Railway's Infrastructure as Code).

### Docker
```bash
docker build -t vxidos-rail .
docker run -p 127.0.0.1:3000:3000 --env-file .env -v vxidos-data:/data vxidos-rail
```

## Features
- **Review dashboard** at `/`, with no build step and a strict CSP. Edit drafts inline, approve or reject them (with an optional note), push approved ones to Buffer, and view the audit trail.
  - Each job has its own section, picked from the nav bar (a sidebar on wide screens): **overview** (counts and limits, with boxes that jump to each section), **create**, **review** (pending), **ready** (approved, send one at a time), **auto-schedule**, **scheduled** (in Buffer, unschedule), **archive** (rejected or all) and **activity**. Sections have their own links (`/#review`), so the back button and bookmarks work.
- **Generation with guardrails**:
  - Pillar rotation: midnight lifestyle, phantom identity, digital-building progress, **dark web3** (rug pulls, drainers, exploits and MEV, written as security awareness rather than how-to) and **privacy protocols** (zk proofs, stealth addresses, shielded pools, Monero and Zcash, FHE and MPC). Each web3 pillar sends the model a topic guide with its theme.
  - Crypto hype and scam bait are rejected: "to the moon", "100x gem", "buy now", "connect your wallet here", airdrop-claim lures, send-X-get-2X. Warnings that mention those things still pass.
  - Recent posts are included in the prompt so it avoids repeats.
  - Output that fails validation (links, unverifiable financial claims, mass mentions, hashtag spam, shorter than 12 characters, or over **280 characters as X counts them**: emoji and CJK count as 2, text is NFC-normalised. The dashboard's live `n/280` counter uses the same code, `src/public/tweetlen.js`) is retried up to 3 times.
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
- **Free backup LLM**: set `FALLBACK_LLM_PROVIDER=groq` (or `cerebras`, `openrouter`, `gemini`) plus `FALLBACK_LLM_API_KEY`. If OpenAI fails (quota, outage, bad key), the draft is written by the backup instead. OpenAI is then skipped for 5 minutes, so an exhausted quota doesn't slow down every draft. The backup also works on its own, with no OpenAI key. Each draft records which provider wrote it, and the dashboard shows it as `via groq`. Free tiers are rate-limited and their models change over time, so `FALLBACK_LLM_MODEL` overrides the default. Check each provider's free-tier terms for how your prompts are used.
- **Auto-schedule up to 100**: the dashboard's *auto-schedule* panel works on approved drafts only, oldest first, alternating pillars. You choose:
  - which **pillars** to include;
  - **posts** (1–100);
  - **posts per day** inside a daily **from–to window**, in your local time. The default is 8 a day, 09:00–23:00, so 100 posts take about 13 days;
  - a start date;
  - optional **±10 min variation**, which stays inside each slot.
- **Preview** shows the exact first and last publish times, how many approved drafts are available, and how many the weekly cap would block. Confirming sends exactly the previewed times.
- Sending runs as a **background job** with a progress bar and **cancel**. It sends about one post every 10 s, because Buffer allows **100 requests per 15 min and 250 a day** (`BUFFER_PACE_MS`), so 100 posts take about 17 min. A Buffer rate-limit response stops the job cleanly, and posts it didn't send stay approved. Jobs live in memory, so a restart ends a running one.
- **Unschedule** deletes the post in Buffer (`deletePost`) and returns the draft to approved. It's available on any queued card that hasn't published, or for a whole batch with *unschedule this batch*.
- **Weekly posting cap**: at most `WEEKLY_POST_CAP` posts (default **200**) can **publish** in any rolling 7 days.
  - Each post counts at its publish time: the scheduled time, or the time Buffer gives a queue slot. A Buffer draft counts when it's sent, since it has no publish time yet.
  - A new send is checked against every 7-day window that would contain it, so scheduling ahead can't stack more than the cap into one week.
  - The check runs inside the store transaction, so concurrent sends can't go over. Past the cap, sending returns `429` naming the full week.
  - The dashboard shows `this week used/cap +N`, where N is posts scheduled ahead.
- **Draft creation sized to the posting cap**: the bot never writes more drafts than it can post.
  - Per rolling 7 days, at most `WEEKLY_DRAFT_CAP` drafts. The default equals `WEEKLY_POST_CAP`, so **200**.
  - Per rolling 24 hours, at most `DAILY_DRAFT_CAP`. The default is the weekly figure ÷ 7, rounded up, so **29**.
  - Both follow `WEEKLY_POST_CAP` automatically. Set a number to override; `auto` keeps the derived value.
  - Covers the dashboard, the API, the CLI and autopilot. It's checked before any LLM call, so a capped request costs nothing.
  - A batch that would go over is cut down to fit and says which cap applied. Rejected drafts still count.
  - The dashboard shows `drafts today` and `drafts this week`.
- **Scheduling**: when sending an approved post you choose how it goes to Buffer:
  - **as Buffer draft** (the default): nothing publishes until you schedule it inside Buffer.
  - **next Buffer slot**: joins your Buffer posting schedule.
  - **schedule at…**: you pick a date and time in your local timezone; it's sent to Buffer as UTC and must be at least a minute ahead and within a year.

  Queued and scheduled posts **publish automatically**. The publish time Buffer reports is shown on the card.
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
| GET | `/stats` | | counts per status, plus `weekly` (posts by publish time, with `scheduled` ahead) and `daily` / `weeklyDrafts` (drafts created) and `creation` (whichever is tighter), each `{cap, used, remaining, nextSlotAt}` |
| GET | `/drafts` | `?status=pending_approval\|approved\|rejected\|queuing\|queued` | newest first |
| GET | `/drafts/:id` | | |
| POST | `/draft` | `{count?: 1-5, pillar?}` | calls the LLM (costs money); `201 {drafts, errors}` |
| PATCH | `/drafts/:id` | `{text, editor}` | pending only; logs the previous text |
| POST | `/drafts/:id/review` | `{decision: "approved"\|"rejected", reviewer, note?}` | |
| POST | `/drafts/:id/queue` | `{reviewer, mode?: "draft"\|"queue"\|"schedule", dueAt?}` (`dueAt` = ISO time, required for `schedule`) | approved only; needs Buffer writes enabled; `429` once the weekly cap is reached |
| GET | `/events` | `?limit=50` | audit log, newest first |
| POST | `/schedule-batch/preview` | `{pillars?, times: [ISO…]}` (or `count`, `startAt`, `intervalMinutes`) | dry run: `{available, requested, items[{dueAt, pillar, text, fits}], blocked}` |
| POST | `/schedule-batch` | same plus `reviewer` (up to 100 times) | starts a background job: `202 {job, notes}` |
| GET | `/jobs`, `/jobs/:id` | | job progress `{state, total, done, results, errors}` |
| POST | `/jobs/:id/cancel`, `/jobs/:id/unschedule` | `{reviewer}` for unschedule | stop a job; undo a whole schedule batch |
| POST | `/drafts/:id/unschedule` | `{reviewer}` | delete in Buffer, back to approved |
| GET | `/buffer/check`, `/buffer/channels` | | read-only |

`/health` also reports `generation` (whether any LLM is configured) and `providers` (in the order they're tried).

Status codes: `400` invalid input, `401`/`429` auth, `404`, `409` wrong state or duplicate, `413` body too large, `502` upstream (OpenAI/Buffer) failure, `503` missing configuration or storage busy.

## Operational limits
- The JSON store is built for **one process on a persistent disk**. Running several instances needs Postgres or Supabase with unique constraints on `hash` and transactional status updates. The `store.js` API is small enough to swap out.
- Auth is a single shared token. Anyone holding it can review, and the `reviewer` name is self-declared. For teams, put an SSO proxy in front (e.g. Cloudflare Access) and derive the reviewer from it.
- Rate limits are in memory and reset when the process restarts. Behind a proxy, set `TRUST_PROXY` (`x-real-ip` on Railway, or a hop count for X-Forwarded-For). Setting it without a proxy lets clients spoof their IP.
- Don't expose the server publicly without TLS and an authenticated proxy.
- A draft stuck in `queuing` (from a crash mid-push) becomes claimable again after 10 minutes. Check Buffer for a duplicate before retrying.
