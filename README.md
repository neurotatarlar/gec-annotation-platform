# Tatar GEC Annotation Platform

Full-stack platform for collaborative grammatical error correction (GEC) of Tatar text. It pairs a FastAPI/Alembic backend, PostgreSQL storage, and a React/Vite frontend tailored for annotator ergonomics (RTL layout, hotkeys, undo, color palettes, cross-validation, etc.).

## Stack
- FastAPI + SQLAlchemy + Alembic with JWT auth and Typer-based admin CLI.
- PostgreSQL for storage; migrations live in `backend/alembic/`.
- React 19 + Vite + Tailwind CSS v4 + React Query on the frontend.
- Dockerfiles and docker-compose for local dev, plus an SSH deploy helper (`scripts/deploy.py`).

## Features
- Task orchestration with one active annotator per text, lock expiry, and required annotation counts.
- Rich annotation workspace (color-coded corrections, hotkeys, undo, sidebar of active edits, cross-validation snapshots).
- English/Tatar UI translations backed by JSON locale files.
- Traceability via versioned annotations and cross-validation queue.
- Admin CLI for creating users, importing/exporting annotations, and managing categories/error types.

## Quick start (Docker Compose)
1. Copy env samples:  
   `cp backend/.env.example backend/.env`  
   `cp frontend/.env.example frontend/.env`
2. Start PostgreSQL: `docker compose up db -d` (exposes port 5433 on the host).
3. Apply migrations and seed data (error types + hotkeys):  
   `docker compose run --rm backend alembic -c alembic.ini upgrade head`  
   The app will auto-create tables on first boot, but running migrations ensures seed data is loaded and the schema matches Alembic history.
4. Launch the app: `docker compose up --build backend frontend`
   - API: `http://localhost:8000` (Swagger UI at `/docs`)
   - Frontend: `http://localhost:4173`

## Manual development (native)
- **Backend**
  ```bash
  python -m venv .venv && source .venv/bin/activate
  pip install -r backend/requirements-dev.txt
  cp .env.example .env  # ensure DATABASE__URL points at your Postgres (e.g., localhost:5433 from docker compose db)
  cd backend
  alembic -c alembic.ini upgrade head
  uvicorn app.main:app --reload
  ```
- **Frontend**
  ```bash
  cd frontend
  npm ci
  cp .env.example .env  # adjust VITE_API_URL if the backend is on a different host/port
  npm run dev -- --host
  ```
The SPA calls `/api/...` paths, so set `VITE_API_URL` to the backend origin **without** a trailing `/api`.

## Makefile shortcuts
Use the root `Makefile` if you prefer one command entrypoint:
- `make help` – list available targets
- `make env` – copy missing `.env` files from examples
- `make install` – install backend and frontend dependencies into the root `.venv` and `frontend/node_modules`
- `make up` – idempotently start backend and frontend locally in the background
- `make down` – stop local background services and Docker Compose services
- `make backend-run` – start the FastAPI backend locally
- `make frontend-run` – start the Vite frontend locally
- `make dev` – run backend and frontend together locally
- `make backend-migrate` – run local Alembic migrations
- `make test` – run backend and frontend test suites
- `make check` – run backend lint, all tests, and frontend build
- `make docker-up` – idempotently restart PostgreSQL, apply migrations, and launch backend/frontend with Docker Compose

Use either the native path (`make install` then `make up`) or the Docker path (`make docker-up`), not both at the same time.

## Environment variables
- **Backend** (uses nested env names via `__`):  
  - `DATABASE__URL` – SQLAlchemy connection string (required).  
  - `DATABASE__POOL_SIZE`, `DATABASE__MAX_OVERFLOW` – optional tuning.  
  - `SECURITY__SECRET_KEY` – JWT signing key (set a strong value in prod).  
  - `SECURITY__ACCESS_TOKEN_EXPIRE_MINUTES` – token TTL (default 12h).  
  - `ENVIRONMENT` – logical environment name (default `development`).
- **Frontend**:  
  - `VITE_API_URL` – backend origin (omit `/api`; the SPA already targets `/api/...`).

## Database & migrations
- Alembic migrations live in `backend/alembic/`; run `alembic -c alembic.ini upgrade head` whenever the schema changes.
- `20240903_02_seed_error_types.py` and `20240903_04_seed_error_type_hotkeys.py` seed the original default palette. `20260812_02_sync_production_error_types.py` replaces those definitions with the ID-stable VPS taxonomy. It relocates only recognized legacy `noop`/`CapitalLowerLetter` references before upserting, and is a no-op when the production taxonomy is already present.
- `20261024_01_drop_annotation_repair_tables.py` removes the four retired recovery tables and their review/audit data. Back up the database before upgrading. Historical migrations remain so existing databases can upgrade without restamping. This cleanup cannot be downgraded; restore a backup to recover the removed data.
- The FastAPI app also calls `Base.metadata.create_all` for convenience; migrations are still the source of truth for schema and seed data.

## Admin CLI
From `backend/` (venv activated) or remotely with `--database-url`:
- Create a user:  
  `python -m app.cli create-user --username admin --password "StrongPass123" --admin`
- Create an annotator through the HTTP API when you have an admin password:
  ```bash
  TOKEN=$(curl -sS -X POST "http://your-domain/api/auth/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=admin&password=ADMIN_PASSWORD" | jq -r .access_token)

  curl -sS -X POST "http://your-domain/api/auth/users" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "username": "new_annotator",
      "password": "StrongPass123",
      "full_name": "Full Name",
      "role": "annotator"
    }'
  ```
- Add a category:  
  `python -m app.cli add-category --name general --description "General texts"`
- Import texts from JSON:  
  `python -m app.cli import-texts data/texts.json`
  ```json
  {
    "category": "common",
    "required_annotations": 2,
    "content": ["text one", "text two"]
  }
  ```
- Export annotations:  
  `python -m app.cli export-annotations output/annotations.json`

Current editor saves use annotation payload schema v2. Source token identities are deterministic
(`base-N`), moves include `move_from`, `move_to`, and `move_len`, and each correction has a stable
`client_correction_id`. The backend treats each annotator's draft as an independent full snapshot;
it never transfers or deletes another annotator's rows. Legacy payloads remain readable for auditing old submissions.

## Reviewing other annotators

All signed-in annotators can inspect saved corrections using the familiar token workspace.
Manzara and history links open combined read-only review; overlapping author alternatives are
shown with the shared annotation chips and error badges. Identical edits are grouped; attribution
and differing versions appear on hover or click. Manzara carries the opened author into review. The existing corrected-text preview shows the latest
submitted author's version, without constructing a merged target. Newly assigned texts open the
usual independent editor. The review/edit toggle switches between saved review and one's own
annotations; review never saves or submits. Restored persistence and layout handling remain active.

## Submitted dataset export
- `GET /api/texts/export` exports the latest submitted annotation task for each selected text.
- Use `category_ids=3` to restrict the export to category 3. Multiple ids are comma-separated.
- The default `format=jsonl` remains backward compatible.
- `format=m2` returns canonical M2 blocks. Generation fails with HTTP 409 if a persisted source
  snapshot or hash is missing, inconsistent, or stale, or if parsing the generated M2 does not
  reconstruct the rendered target exactly.
- `format=m2-audit` reruns the same validated export and returns a JSON sidecar. Its `m2_sha256`
  identifies the matching M2 bytes, `counts` summarizes the dataset, and `label_issues` identifies
  edits exported as `OTHER` because overlapping corrections or repeated-token alignment made the
  original error label ambiguous.

Example authenticated export:
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/texts/export?category_ids=3&format=m2" \
  -o submitted-category-3.m2
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/texts/export?category_ids=3&format=m2-audit" \
  -o submitted-category-3.m2.audit.json
sha256sum submitted-category-3.m2
```

Current schema-v2 editor saves include the corrected text visible in the browser and its SHA-256
when Web Crypto is available. The backend independently renders the submitted operations and
rejects a mismatch before writing, in addition to validating stable `base-N` identities and
complete operation coordinates.

For restored annotations that must preserve literal paragraph layout, payloads may set
`preserve_source_layout: true`. Source gaps are then hydrated from the verified source snapshot;
after-token fragments carry `line_breaks_before` and optional literal `whitespace_before`.
Both renderers preserve these fields through reload and canonical serialization, so adding or
removing words does not relocate paragraph breaks by token count. Legacy payloads retain their
existing rendering behavior. Run the backend annotation tests, frontend token editor tests,
and a production frontend build before deploying changes to this contract.

## Reviewed training snapshots

A verified manual-review training package uses UTF-8 JSONL with `id`, `source`, `target`, and
`corrections` per text. Each correction retains its reviewed error type and zero-based Unicode
code-point source span (`start` inclusive, `end` exclusive). Move/compound corrections also carry
`linked_removals`; applying the primary replacement and linked removals together must reproduce
`target` exactly. This character-span format is distinct from the normal API export's token edits.

Include only texts with at least one accepted correction, preserving rejected spans as original text.
Select the confirmed text/author pairs explicitly: the normal submitted export omits texts with
`trash` or `skipped` workflow states, which can include texts later confirmed during manual review.
Compare the exported production source, target, and error types with the confirmed decisions,
then independently apply the exported character edits to verify every target. JSONL preserves
literal spacing and paragraph breaks; optional M2 conversion normalizes layout and may produce
`OTHER` labels when alignment cannot preserve a unique error type. Keep its label-issue audit.
Private cases, decisions, export packages, and verification reports remain in ignored `output/`.

## Local manual annotation review

For reviewing individual records together, run:

```bash
python scripts/annotation_review.py --data-dir output/manual-review --port 8765
```

Open `http://127.0.0.1:8765/`. Each prepared `cases/text-ID.json` has a separate `/text/ID.html`
page with highlighted source spans, proposed replacements, editable error types, and per-correction
review decisions. Cases contain explicit source character spans supplied during manual review;
the tool does not infer historical intent. Accept opens the next undecided correction; after the last
acceptance, the panel collapses and focuses Confirm text. Moves can link an insertion and source
removal to one decision. Move cards show the original and proposed positions in sentence context,
with matching From/To markers in the text panels. Accept or reject every correction before confirming a text.
Drafts and confirmations are validated and saved by the local server under `decisions/`, with an
immutable JSON copy of each revision under `history/`. Reload uses the saved response. The server
binds to localhost, expires idle connections after two seconds so browser preconnections cannot
block review pages, does not contact production, and does not modify the annotation database.
Private case data and decisions stay under ignored `output/`. Run its focused checks with
`python -m unittest discover -s scripts/tests -p 'test_annotation_review.py'` and
`node scripts/tests/annotation_review_ui.test.mjs` (uses the frontend development dependencies).

For assistant-assisted batch review, assess 25 source records per pass. Automatically confirm a
whole text only when every saved correction has clear source evidence, meaning, operation, and
error type. Leave the entire text as a draft with all corrections pending if any edit is uncertain;
flag newly noticed unannotated errors for human review. Preserve existing confirmations and drafts.
Record automatic confirmation explicitly in the decision note, validate all source spans and row
coverage, and verify saved targets against their immutable revision history. Keep the local policy
in `output/manual-review/review-policy.json` and batch reports and review links under
`output/manual-review/batches/`. This workflow uses explicitly prepared cases and the existing
save validator; it does not infer corrections automatically or write to the production database.

## Payout reports API
- Endpoint: `GET /api/reports/review-totals` (admin/manager token required).
- Primary metric: `submitted_total` (count of `annotation_tasks` with `status='submitted'`).
- Delta metric: `submitted_since` (submitted tasks with `updated_at >= since`).
- Filters:
  - `project_name` **or** `category_id` (exactly one is required)
  - `roles` (comma-separated, default `annotator`)
  - `since` / `until` (ISO datetime, optional)
  - `include_inactive` (default `false`)
  - `only_with_activity` (default `true`)

Example: totals and delta since your last payout snapshot:
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/reports/review-totals?project_name=%D0%A2%D0%B0%D0%BC%D0%B3%D0%B0%D0%BB%D0%B0%D1%83%20%D1%82%D3%A9%D0%BF%20%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B&roles=annotator&since=2026-03-16T16:11:10Z"
```

Example: include admins in the same report:
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/reports/review-totals?project_name=%D0%A2%D0%B0%D0%BC%D0%B3%D0%B0%D0%BB%D0%B0%D1%83%20%D1%82%D3%A9%D0%BF%20%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B&roles=annotator,admin"
```

## Testing
- Frontend: `cd frontend && npm test`
- Backend: `cd backend && pytest` (after `pip install -r requirements-dev.txt`)
- Deployment workflow orchestration: `make deploy-test` (uses mocked SSH/curl commands and does not contact the server)
- CI also upgrades an empty PostgreSQL 15 database to Alembic head, reruns the latest data migration, and verifies that IDs `1`–`28` remain stable.

## Coding conventions
- Python: 4-space indentation; Ruff enforces a 100-character line length in `backend/pyproject.toml`. Keep route handlers thin, keep Pydantic schemas typed, and move business logic into `backend/app/services/`.
- React/TypeScript: use functional components with PascalCase filenames. Keep hooks in `frontend/src/hooks/` with `use*` names, API adapters in `frontend/src/api/`, and shared types in `frontend/src/types.ts`.
- Styling: prefer existing Tailwind utility patterns and `clsx` for conditional class composition.
- Config: copy the `.env.example` files in `backend/` and `frontend/`, never commit secrets, and keep `VITE_API_URL` pointed to the backend origin without a trailing `/api`.

## Test authoring guidelines
- Backend tests use in-memory SQLite and set `SKIP_CREATE_ALL`; prefer fixtures and overrides over real network or database dependencies.
- When changing persistence or validation logic, cover the affected router and service paths.
- Frontend tests use Vitest and Testing Library; keep specs close to the code they cover and assert user-visible behavior such as hotkeys, annotation flows, and API adapter interactions.

## Contributing
- Commits should use concise, imperative subjects, for example `Add text assignment lock validation`.
- Keep backend, frontend, and deploy changes separate when practical.
- If a change affects migrations or seed data, mention that in the commit body or pull request.
- Pull requests should include a short summary, linked issues when relevant, and the commands used to verify the change.
- Attach screenshots or GIFs for UI changes, and call out database or environment changes explicitly.

## Deployment
- SSH helper lives at `scripts/deploy.py` with `init` (server bootstrap) and `deploy` (sync code, run Alembic, build frontend, restart services).
- Requirements:
  - Debian 12+ server reachable over SSH with a sudo-enabled user
  - local machine with Python 3, `rsync`, and `ssh`
  - Node.js 20.19+ on the server (the bootstrap installs Node.js 20)
  - DNS/SSL can be layered on later; the helper configures HTTP on port 80
- One-time server bootstrap:
  ```bash
  python scripts/deploy.py init \
    --host user@your-server \
    --app-dir /opt/gec-app \
    --frontend-dist-dir /var/www/gec-frontend \
    --service-name gec-backend \
    --db-name gec \
    --db-user gec \
    --db-password 'strong-password' \
    --secret-key 'jwt-secret'
    # --s3-bucket ...  # optional: enable daily DB backups
  ```
- Bootstrap provisions:
  - system packages (`git`, `rsync`, Python, Node, nginx, PostgreSQL 15, `ufw`, `awscli`)
  - PostgreSQL, including DB/user creation and WAL archive setup
  - application directories, Python virtualenv, and `backend.env`
  - nginx config to serve frontend and proxy `/api/` to uvicorn on port 8000
  - systemd service for `uvicorn app.main:app`
  - optional daily S3 database backup job
- Deploy updates:
  ```bash
  python scripts/deploy.py deploy \
    --host user@your-server \
    --ssh-key ~/.ssh/deploy-key \
    --app-dir /opt/gec-app \
    --frontend-dist-dir /var/www/gec-frontend \
    --service-name gec-backend \
    --frontend-api-url https://your-domain
  ```
- Use the base origin for `--frontend-api-url` with no trailing `/api`.
- Deploy performs:
  - repository sync into `$APP_DIR/app`
  - backend dependency install and env loading
  - `alembic -c alembic.ini upgrade head`
  - frontend build with `VITE_API_URL=$FRONTEND_API_URL`
  - systemd restart and nginx reload
- Post-deploy checks:
  - health check: `curl -f http://localhost:8000/health`
  - service status: `sudo systemctl status gec-backend`
  - remote admin CLI example:
    `ssh user@your-server "/opt/gec-app/venv/bin/python -m app.cli create-user --username admin --password 'StrongPass123' --admin"`
  - if S3 backups are enabled, archives live under `/var/backups/gec` with 7-day retention and errors go to `/var/log/gec-db-backup.log`

### GitHub Actions deployment

The `Deploy server` workflow wraps the same `scripts/deploy.py deploy` command for the
single shared server. It is manual-only and deploys from `main`; run it after the `CI`
workflow has passed for the commit you want to release.

Create a GitHub environment named `server` and configure these environment values:

- Variables:
  - `DEPLOY_SSH_HOST` – VPS hostname or IP address
  - `DEPLOY_SSH_USER` – sudo-enabled SSH user
  - `DEPLOY_PUBLIC_ORIGIN` – public base origin without a trailing slash or `/api`
  - `DEPLOY_APP_DIR` – optional, defaults to `/opt/gec-app`
  - `DEPLOY_FRONTEND_DIST_DIR` – optional, defaults to `/var/www/gec-frontend`
  - `DEPLOY_SERVICE_NAME` – optional, defaults to `gec-backend`
- Secrets:
  - `DEPLOY_SSH_PRIVATE_KEY` – private key accepted by the VPS user
  - `DEPLOY_SSH_KNOWN_HOSTS` – trusted `known_hosts` line for the VPS; obtain and verify
    the server fingerprint before adding it

Run the workflow from **Actions → Deploy server → Run workflow** on `main`. It validates
SSH and sudo access, checks the existing installation, creates an incremental pgBackRest
backup when the configured stanza is available or a local `pg_dump` otherwise, runs the
deploy helper, verifies the
backend service and local health endpoint, checks the public frontend, and records the
deployed commit in `$DEPLOY_APP_DIR/deployed-commit`.

The remote orchestration is implemented in `scripts/deploy_workflow.sh` so the GitHub
workflow and local tests execute the same commands. Run `make deploy-test` before changing
deployment configuration; its mock integration test verifies validation, SSH targets,
backup/deploy arguments, health checks, and commit recording without reaching the VPS.
For local runs with a non-default private key, set `DEPLOY_SSH_KEY`. Fallback database
dumps are stored under `/var/backups/gec` on the server and retained for 30 days.

## Project layout
- `backend/` – FastAPI app, SQLAlchemy models, Alembic migrations, Typer CLI.
- `frontend/` – React/Vite SPA with RTL-friendly annotation workspace.
- `scripts/deploy.py` – Debian bootstrap + deploy automation.
