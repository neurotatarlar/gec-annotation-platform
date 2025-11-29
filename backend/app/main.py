from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import engine
from .models import Base
from .routers import auth, categories, error_types, texts

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Tatar GEC Annotation API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(categories.router)
app.include_router(error_types.router)
app.include_router(texts.router)


@app.get("/health")
def healthcheck():
    return {"status": "ok"}
