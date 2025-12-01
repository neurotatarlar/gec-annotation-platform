import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import engine
from .models import Base
from .routers import auth, categories, error_types, texts
from .config import get_settings

# Allow skipping table creation in test environments (e.g., sqlite without JSONB).
if not os.getenv("SKIP_CREATE_ALL"):
    Base.metadata.create_all(bind=engine)

app = FastAPI(title="Tatar GEC Annotation API", version="0.1.0")

settings = get_settings()
allowed_origins = settings.allowed_origins or []
allow_origin_regex = None
# If "*" is explicitly configured, allow all origins.
if any(origin == "*" for origin in allowed_origins):
    allow_origin_regex = ".*"
    allowed_origins = []
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(auth.router)
app.include_router(categories.router)
app.include_router(error_types.router)
app.include_router(texts.router)


@app.get("/health")
def healthcheck():
    return {"status": "ok"}
