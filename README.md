# Relay Chat: multi-turn LLM chatbot with key failover and response caching

React + Vite + Tailwind frontend, FastAPI + LiteLLM backend, SQLite storage, Docker Compose.

## Live URLs

| Service  | URL |
|----------|-----|
| Frontend | _not deployed yet: add your Vercel/Netlify URL here after step 3 below_ |
| Backend  | _not deployed yet: add your Render/Railway URL here after step 2 below_ (`/health` should return `{"status":"ok",...}`) |

### Deploying

1. **Push to GitHub.** `.env` is git-ignored; only `.env.example` is committed. Never commit real keys.
2. **Backend on Render** (any Docker host with a persistent disk works).
   - New > Blueprint, pick the repo; `render.yaml` creates a Docker web service with a 1 GB disk mounted at `/data`.
   - Set secrets in the dashboard: `LLM_API_KEYS` (two or more keys, comma separated) and `CORS_ORIGINS` (your frontend origin, e.g. `https://relay-chat.vercel.app`, no trailing slash).
   - Leave `ENABLE_FAILURE_SIMULATION=false` unless you want reviewers to trigger failures on the public URL.
   - Persistent disks need a paid instance type. On a free instance the SQLite file is wiped on every deploy/restart.
   - Verify: `curl https://<backend>/health`.
3. **Frontend on Vercel** (or Netlify; `netlify.toml` is included).
   - Import the repo, set the **root directory to `frontend`**.
   - Add the environment variable `VITE_API_URL=https://<backend>` (public URL only, no secrets) and deploy. It is read at build time, so redeploy after changing it.
   - Go back to the backend and make sure `CORS_ORIGINS` contains the final Vercel URL.

## Run locally: with Docker and without

### With Docker (recommended)

```bash
cp .env.example .env      # then put real keys in LLM_API_KEYS
make up                   # builds and starts everything
make down                 # stops it (the SQLite volume is kept)
```

- Frontend: http://localhost:3000, backend: http://localhost:8000 (`/health`, `/docs`)
- `make logs`, `make restart`, `make test`, and `make clean` (stop **and** delete the `/data` volume).
- `make up` copies `.env.example` to `.env` if you forgot, but the placeholder keys will make chat requests return 503 until you replace them.

### Without Docker

```bash
# backend (Python 3.12)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export LLM_API_KEYS=key1,key2 DATABASE_URL=sqlite:///./app.db ENABLE_FAILURE_SIMULATION=true
uvicorn app.main:app --reload --port 8000

# frontend (Node 20+), in a second terminal
cd frontend
npm install
VITE_API_URL=http://localhost:8000 npm run dev      # http://localhost:3000
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LLM_API_KEYS` | none (required) | Comma-separated key pool, exposed internally as `key_1`, `key_2`, ... |
| `LLM_MODEL` | `gemini/gemini-2.0-flash` | Any LiteLLM model string; keys must belong to that provider |
| `LLM_TIMEOUT_SECONDS` | `30` | Per-attempt provider timeout |
| `CACHE_ENABLED` | `true` | LiteLLM in-memory response cache |
| `ENABLE_FAILURE_SIMULATION` | `false` | Enables the `X-Simulate-Failure` header |
| `DEFAULT_SYSTEM_PROMPT` | empty | Used when a session has no system prompt |
| `DATABASE_URL` | `sqlite:////data/app.db` | SQLite file (Docker named volume at `/data`) |
| `CORS_ORIGINS` | `http://localhost:3000,...` | Allowed browser origins |
| `VITE_API_URL` | `http://localhost:8000` | Backend URL baked into the frontend build |
| `PORT` | `8000` | Injected by Render/Railway; used by the container command |

### API

| Endpoint | Behaviour |
|---|---|
| `GET /health` | `200 {"status":"ok","keys_configured":N,"cache_enabled":bool}` when the app is up, SQLite answers a query, and at least one key is loaded; otherwise `503` |
| `POST /chat` | Body `{session_id (1-128), message (1-4000 after trim), system_prompt?}`. Returns `{session_id, reply, metadata{resolution_source, model, latency_ms, input_tokens, output_tokens, key_id, fallback_attempts}}`. `422` on validation errors, `503 {"detail":"all providers unavailable"}` when every key fails |
| `GET /sessions/{id}/messages` | Chronological history from SQLite (system prompt never included); `404 {"detail":"session not found"}` for unknown sessions |

### Testing

```bash
make test          # or: cd backend && pip install -r requirements-dev.txt && python -m pytest -q
```

The suite makes no network calls. It registers a LiteLLM *custom provider* (`fake/echo`), so requests still pass through the real LiteLLM cache layer, exception classes, and per-key `api_key` routing; only the HTTP hop is replaced. It covers health, chat, multi-turn memory, session isolation, SQLite persistence across an app restart, cache hits and consistency, cache-key sensitivity (system prompt, history, message), failover on genuine 429/500 provider errors, the simulation header (429, 500, 502, 503, multiple keys, wildcard), all-keys-down 503, validation, 404, failed requests not being stored, and API keys never appearing in responses.

## Design decisions: key fallback, caching, SQLite session storage

**Key fallback.** `LLM_API_KEYS` becomes an ordered pool (`key_1`, `key_2`, ...). For each request `LLMService.complete` tries keys in order, calling `litellm.completion(api_key=..., num_retries=0)`. A 429, quota error, 5xx, timeout, connection error, or auth error on one key moves on to the next; `fallback_attempts` counts the keys that failed and `key_id` names the one that answered. If every key fails the API returns `503 {"detail":"all providers unavailable"}` and nothing is written to the database. A non-retryable rejection (for example a 400 because the prompt itself is invalid) is *not* retried across keys, because it would fail identically everywhere; it returns a generic 502. Provider error text is logged by type and status only, so neither keys nor stack traces reach clients or logs. Trade-off: the order is deterministic and stateless (no cooldown for a key that keeps failing), which keeps behaviour predictable and testable. A cooldown/circuit breaker is the natural next step.

**Failure simulation.** `X-Simulate-Failure: key_1=429,key_2=500` or `*=429` is honoured only when `ENABLE_FAILURE_SIMULATION=true`. A simulated key still goes through `litellm.completion`, using LiteLLM's `mock_response` to raise a real `litellm.RateLimitError` / `InternalServerError` / `BadGatewayError` / `ServiceUnavailableError`, so the exact same `except` branch handles simulated and genuine failures. Keys that are not failed make a real provider call and return a real answer. Simulated requests skip the cache *read* (but still populate the cache) so a cached answer can never mask a simulated outage.

**Caching.** LiteLLM's built-in in-memory cache (`litellm.cache = Cache(type="local")`). Its key is derived from the model and the full `messages` list, and the backend always sends `[system prompt?] + stored history + new user message`. So the system prompt and the history are part of the key, identical first messages in different sessions hit the cache, and different messages, histories, or prompts do not collide. `api_key` is not part of the key, so a cached answer is reusable no matter which key produced it. On a hit the response carries its original `usage`, so token counts are the stored ones; `resolution_source` is `LLM_CACHE`, `key_id` is `null`, and `fallback_attempts` is `0`. The cache lives in process memory, so it resets when the backend restarts (chat history in SQLite does not). This LiteLLM version has no built-in disk cache type, so I did not add one.

**SQLite session storage.** `messages(id, session_id, role, content, metadata, created_at)` plus a small `sessions` table holding each session's system prompt (kept out of the messages table so it can never be returned by the history endpoint). Both tables are created at startup. The user message and assistant reply are written in one transaction *after* a successful completion, so failed requests leave no trace. History is ordered by autoincrement id. The server sends the full history to the model; the frontend only ever sends the new message. A per-session lock serialises concurrent turns in the same session. A new system prompt in a request replaces the stored one; omitting it reuses the stored one. In Docker the file lives on the named volume `app_data` mounted at `/data`.

## Verification: how to see failover, cache hits and per-message token usage

Set `ENABLE_FAILURE_SIMULATION=true` and use two real keys, then:

```bash
# 1. Live inference
curl -s localhost:8000/chat -H 'content-type: application/json' \
  -d '{"session_id":"demo-1","message":"What is the capital of France?"}'
#    -> resolution_source LIVE_INFERENCE, key_id key_1, fallback_attempts 0

# 2. Cache hit: same first message, different session
curl -s localhost:8000/chat -H 'content-type: application/json' \
  -d '{"session_id":"demo-2","message":"What is the capital of France?"}'
#    -> LLM_CACHE, key_id null, fallback_attempts 0, same reply and token counts, lower latency_ms

# 3. Failover: key_1 "rate limited"
curl -s localhost:8000/chat -H 'content-type: application/json' -H 'X-Simulate-Failure: key_1=429' \
  -d '{"session_id":"demo-3","message":"Name a prime number."}'
#    -> HTTP 200, key_id key_2, fallback_attempts 1, a real model answer

# 4. Everything down
curl -si localhost:8000/chat -H 'content-type: application/json' -H 'X-Simulate-Failure: *=429' \
  -d '{"session_id":"demo-4","message":"hello"}'
#    -> HTTP 503 {"detail":"all providers unavailable"}
curl -i localhost:8000/sessions/demo-4/messages     # -> 404, nothing was stored

# 5. Per-message token usage and persistence
curl -s localhost:8000/sessions/demo-1/messages
```

In the UI: send a prompt, click **Clear chat** (new session), then send the same first message again to see `LLM_CACHE`. The sidebar's **Simulate key failure** dropdown sends the header for you. Every assistant message shows its own source, model, latency, input tokens, and output tokens (input tokens grow with each turn because history is resent; output tokens are per reply). To check persistence: `make down && make up`, then `GET /sessions/<id>/messages` still returns the history.

## Setup Used: your editor and AI tools

- AI: Claude (Anthropic), used to generate the code, tests, and this README, and to run the backend test suite and frontend build in a sandbox.
- Libraries: FastAPI, LiteLLM, SQLAlchemy, React, Vite, Tailwind CSS, Axios.
- Editor: _add your own editor here (for example VS Code or Cursor)._

## Bonus features (if any): what you added beyond the requirements and why

- **Simulate key failure** dropdown in the UI, so failover can be demonstrated without curl.
- **Clear chat** starts a fresh session, which also makes cache hits easy to demonstrate.
- Answer footnote explaining which key answered and how many failed first, or that it was served from cache.
- Failed sends are rolled back in the UI and the text is restored to the input for a retry.
- Healthcheck-gated startup in Compose, non-root backend container, WAL mode for SQLite, and `render.yaml` / `vercel.json` / `netlify.toml` for one-step deployment.
