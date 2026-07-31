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
- `20240903_02_seed_error_types.py` and `20240903_04_seed_error_type_hotkeys.py` seed the default error palette and hotkeys—keep them applied for a usable UI.
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
