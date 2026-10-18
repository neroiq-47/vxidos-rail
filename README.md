# VXIDOS Rail v0.2 — audited approval-first starter

## Improvements
- Explicit draft IDs and trimmed Unicode-aware length checks
- Transactional file-backed draft store with duplicate prevention and review audit events
- Authenticated review and listing endpoints; timing-safe token comparison
- Drafts remain local; **no Buffer publishing mutation is enabled**

## Run
Requires Node.js 20+.
```bash
npm install
cp .env.example .env
# Edit .env: OPENAI_API_KEY, RAIL_SECRET
npm test
npm run draft
npm start
```

## Endpoints
All except `/health` require `Authorization: Bearer $RAIL_SECRET`.
- `GET /health` — health status
- `POST /draft` — generate pending draft (OpenAI cost incurred)
- `GET /drafts` — list drafts
- `POST /drafts/:id/review` — JSON `{"decision":"approved","reviewer":"owner"}` or `rejected`
- `GET /buffer/check` — read-only Buffer API test

## Production gaps
This JSON file is safe only for a **single process on persistent local disk**. Use Supabase/Postgres with unique constraints and transactional status transitions before multi-instance deployment. The lock file can remain after a crash and needs manual recovery. Add request rate limiting, user authentication, role-based authorization, metrics, secrets manager, job idempotency, semantic duplicate checks, and editorial review. Do not expose the localhost server publicly without an authenticated proxy. Approved drafts are **not automatically published**. Buffer draft creation must be implemented only after verifying the live GraphQL mutation and channel permissions. Stripe webhooks and paid entitlements are not implemented.
