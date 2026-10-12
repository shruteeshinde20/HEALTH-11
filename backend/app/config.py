from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# backend/app/config.py -> project root. Using an absolute path means the
# root .env is found no matter which folder the server is started from.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DEV_JWT_SECRET = "development-only-change-this-secret-before-production"


class Settings(BaseSettings):
    app_name: str = "HEALTH-11"
    environment: str = "development"
    api_v1_prefix: str = "/api/v1"
    database_url: str | None = None
    postgres_db: str = "health11"
    postgres_user: str = "health11"
    postgres_password: str = "replace_me"
    postgres_host: str = "127.0.0.1"
    postgres_port: int = 5433
    jwt_secret_key: str = DEFAULT_DEV_JWT_SECRET
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7
    # Accepts a comma-separated list (http://a,http://b) or a JSON list.
    cors_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    ]
    log_level: str = "INFO"

    # Rate limits (stored in PostgreSQL, so they hold across server workers).
    rate_limit_window_seconds: int = 900
    login_max_attempts_per_ip: int = 30
    login_max_failures_per_account: int = 5
    register_max_attempts_per_ip: int = 5
    register_window_seconds: int = 3600

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8-sig",
        extra="ignore",
        case_sensitive=False,
    )

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        from sqlalchemy.engine import URL

        return URL.create(
            "postgresql+psycopg",
            username=self.postgres_user,
            password=self.postgres_password,
            host=self.postgres_host,
            port=self.postgres_port,
            database=self.postgres_db,
        ).render_as_string(hide_password=False)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value):
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                import json

                value = json.loads(text)
            else:
                value = [item.strip() for item in text.split(",")]
        origins = [origin.rstrip("/") for origin in value if origin]
        if "*" in origins:
            raise ValueError(
                "CORS_ORIGINS cannot contain '*' because credentials are allowed"
            )
        return origins

    @field_validator("environment")
    @classmethod
    def validate_environment(cls, value: str) -> str:
        value = value.lower()
        if value not in {"development", "test", "production"}:
            raise ValueError("ENVIRONMENT must be development, test, or production")
        return value

    @model_validator(mode="after")
    def validate_production_secrets(self):
        if self.environment == "production":
            if len(self.jwt_secret_key) < 32:
                raise ValueError(
                    "JWT_SECRET_KEY must be at least 32 characters in production"
                )
            if self.jwt_secret_key == DEFAULT_DEV_JWT_SECRET:
                raise ValueError("Set a unique JWT_SECRET_KEY in production")
            if "replace_me" in self.resolved_database_url.lower():
                raise ValueError(
                    "Configure a valid database password and URL in production"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
