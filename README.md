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
  cd backend
  python -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  cp .env.example .env  # ensure DATABASE__URL points at your Postgres (e.g., localhost:5433 from docker compose db)
  alembic -c alembic.ini upgrade head
  uvicorn app.main:app --reload
  ```
- **Frontend**
  ```bash
  cd frontend
  npm install
  cp .env.example .env  # adjust VITE_API_URL if the backend is on a different host/port
  npm run dev -- --host
  ```
The SPA calls `/api/...` paths, so set `VITE_API_URL` to the backend origin **without** a trailing `/api`.

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

## Testing
- Frontend: `cd frontend && npm test`
- Backend: `cd backend && pytest`

## Deployment
- SSH helper lives at `scripts/deploy.py` with `init` (server bootstrap) and `deploy` (sync code, run Alembic, build frontend, restart services).
- Example:  
  `python scripts/deploy.py init --host user@server --app-dir /opt/gec-app --db-password 'strong'`  
  `python scripts/deploy.py deploy --host user@server --frontend-api-url https://your-domain`
- See `docs/deployment.md` for full flags, backup options, and verification steps.

## Project layout
- `backend/` – FastAPI app, SQLAlchemy models, Alembic migrations, Typer CLI.
- `frontend/` – React/Vite SPA with RTL-friendly annotation workspace.
- `scripts/deploy.py` – Debian bootstrap + deploy automation.
- `docs/` – design notes and ops guides (see `docs/deployment.md`).
