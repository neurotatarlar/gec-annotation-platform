# Repository Guidelines

## Project Structure & Module Organization
- `backend/` FastAPI service; entry at `app/main.py`, routers in `app/routers/`, schemas in `app/schemas/`, services in `app/services/`, and models in `app/models/`. Alembic migrations live under `backend/alembic/`.
- `frontend/` React/Vite SPA; `src/api` for HTTP adapters, `src/components` for shared UI, `src/pages` for screens, `src/hooks` for custom hooks, `src/i18n` for locale JSON, and `src/styles` for Tailwind helpers.
- `docs/` holds operational notes; `scripts/deploy.py` automates SSH-based deploys; `docker-compose.yml` wires the local stack.

## Build, Test, and Development Commands
- Dockerized workflow: `docker compose up db -d` (Postgres on 5433) → `docker compose run --rm backend alembic -c alembic.ini upgrade head` → `docker compose up --build backend frontend`.
- Backend (native): 
  ```bash
  cd backend
  python -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  alembic -c alembic.ini upgrade head
  uvicorn app.main:app --reload
  ```
- Frontend: 
  ```bash
  cd frontend
  npm install
  npm run dev -- --host
  ```

## Coding Style & Naming Conventions
- Python: 4-space indent; Ruff enforces style with 100-char lines (`backend/pyproject.toml`). Keep Pydantic schemas typed, route handlers thin, and move business logic into `services/`.
- React/TypeScript: functional components with PascalCase filenames; hooks prefixed `use*` live in `src/hooks`; API wrappers stay in `src/api`; shared types in `src/types.ts`. Favor Tailwind utility classes and `clsx` for conditional styling.
- Config: copy `.env.example` files in `backend/` and `frontend/`; never commit secrets. Match `VITE_API_URL` to your backend origin (no `/api` suffix).

## Testing Guidelines
- Backend: `cd backend && pytest`; suite uses in-memory SQLite and overrides `SKIP_CREATE_ALL`. Add fixtures instead of real network/db calls; cover routers/services when changing persistence or validation.
- Frontend: `cd frontend && npm test` (Vitest + Testing Library). Place specs near components or in `__tests__` folders; assert hotkeys, annotation flows, and API adapter behavior.

## Commit & Pull Request Guidelines
- Commits: concise, imperative subjects (e.g., `Add text assignment lock validation`); separate backend/frontend/deploy changes when possible; mention Alembic revision IDs and seed data adjustments in the body.
- PRs: include summary, linked issues, and test results/commands run. Attach screenshots or GIFs for UI changes. Call out database/env changes so reviewers can sync migrations and config.
