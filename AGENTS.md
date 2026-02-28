# Agent Notes

- `README.md` is the canonical source for project setup, run commands, testing workflow, coding conventions, and contribution guidance.
- Keep repository instructions in sync by updating `README.md` first and only keeping agent-specific notes here.
- Project layout:
  - `backend/`: FastAPI app, routers in `app/routers/`, services in `app/services/`, models in `app/models/`, migrations in `backend/alembic/`
  - `frontend/`: React/Vite app, pages in `src/pages/`, shared components in `src/components/`, hooks in `src/hooks/`
  - `scripts/deploy.py`: deployment helper
