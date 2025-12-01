from functools import lru_cache
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseModel):
    url: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/gec",
        description="SQLAlchemy connection string",
    )
    pool_size: int = 10
    max_overflow: int = 10


class SecuritySettings(BaseModel):
    secret_key: str = Field(default="change-me", description="JWT signing key")
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 12


class AppSettings(BaseSettings):
    environment: str = "development"
    database: DatabaseSettings = DatabaseSettings()
    security: SecuritySettings = SecuritySettings()
    allowed_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_nested_delimiter="__",
        extra="ignore",
    )


@lru_cache
def get_settings() -> AppSettings:
    return AppSettings()
