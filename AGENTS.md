# Agent Notes

- `README.md` is the canonical source for project setup, run commands, testing workflow, coding conventions, and contribution guidance.
- Keep repository instructions in sync by updating `README.md` first and only keeping agent-specific notes here.
- Project layout:
  - `backend/`: FastAPI app, routers in `app/routers/`, services in `app/services/`, models in `app/models/`, migrations in `backend/alembic/`
  - `frontend/`: React/Vite app, pages in `src/pages/`, shared components in `src/components/`, hooks in `src/hooks/`
  - `scripts/deploy.py`: deployment helper

## Annotation Architecture Rules

- Treat backend persistence as canonical. The frontend may hold transient interaction state, but saved annotation state must come from backend responses.
- Do not silently drop corrections during save. Draft saves may include incomplete corrections; submit validation must reject incomplete real corrections.
- Keep submit rules enforced on the backend even when the frontend disables or guards the submit button.
- Prefer one normalized draft-correction representation and derive UI, sidebar, render payloads, and save payloads from it.
- Keep annotation serialization and hydration symmetric: every saved annotation shape should round-trip through reload without changing meaning.
- Keep operation semantics explicit: `replace`, `delete`, `insert`, `move`, and `noop` should not be inferred from visual styling alone.
- Keep annotator correction sets independent. A save may replace the current annotator's full draft, but must not transfer, overwrite, or delete another annotator's rows.
- New annotation writes must use the canonical v2 contract: deterministic `base-N` source identities, stable correction IDs, complete move coordinates, and verified source snapshots.
- Avoid adding new localStorage-backed annotation state. Local storage is acceptable for small UI preferences only.
- Add regression tests before changing token editing, spacing, move/delete/insert behavior, autosave, hydration, or submit flow.
- For risky annotation changes, verify backend tests, frontend token editor tests, and a production frontend build before deployment.
