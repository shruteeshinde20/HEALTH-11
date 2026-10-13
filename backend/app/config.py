from functools import lru_cache
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

from pydantic import Field, SecretStr, field_validator, model_validator
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
    # Lifetime of the one-run token the website uses to open a live
    # simulation stream (WebSocket). Short, because it travels in a URL.
    stream_token_expire_seconds: Annotated[int, Field(ge=10, le=600)] = 60
    # Accepts a comma-separated list (http://a,http://b) or a JSON list.
    cors_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    ]
    log_level: str = "INFO"
    # Where trained machine-learning models are stored (one folder per organization).
    model_dir: Path = PROJECT_ROOT / "var" / "models"

    # AI assistant. AI_PROVIDER picks the service; its key and model must be set
    # in .env, never in code.
    ai_provider: str = "anthropic"
    anthropic_api_key: SecretStr | None = None
    anthropic_model: str | None = None
    gemini_api_key: SecretStr | None = None
    gemini_model: str | None = None
    gemini_api_version: str = "v1"
    # True while using Google's free API tier, where Google may use what is sent
    # to improve its products. Not allowed in production.
    gemini_free_tier: bool = True
    # Ollama: a model running on this computer (https://ollama.com). No key;
    # local models answer more slowly, so they get their own time limit.
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str | None = None
    ollama_timeout_seconds: float = Field(default=180.0, gt=0, le=1800)
    assistant_timeout_seconds: float = 30.0
    assistant_max_requests_per_user: int = 20
    assistant_window_seconds: int = 600

    # Reports. Optional TrueType font (.ttf) for names in other scripts; the
    # built-in PDF font covers Western European letters only.
    report_font_path: Path | None = None
    report_max_requests_per_user: int = 30
    report_window_seconds: int = 600

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

    @field_validator("ai_provider")
    @classmethod
    def validate_ai_provider(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"anthropic", "gemini", "ollama"}:
            raise ValueError("AI_PROVIDER must be anthropic, gemini or ollama")
        return value

    @field_validator("ollama_url")
    @classmethod
    def validate_ollama_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.path or parsed.query:
            raise ValueError("OLLAMA_URL must look like http://127.0.0.1:11434")
        return value

    @property
    def ollama_is_local(self) -> bool:
        return urlparse(self.ollama_url).hostname in {"127.0.0.1", "localhost", "::1"}

    @field_validator("gemini_api_version")
    @classmethod
    def validate_gemini_api_version(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"v1", "v1beta"}:
            raise ValueError("GEMINI_API_VERSION must be v1 or v1beta")
        return value

    @field_validator("report_font_path", mode="before")
    @classmethod
    def validate_report_font_path(cls, value):
        # An empty REPORT_FONT_PATH= line means "not set".
        if value is None or str(value).strip() == "":
            return None
        value = Path(str(value).strip())
        if value.suffix.lower() != ".ttf" or not value.is_file():
            raise ValueError("REPORT_FONT_PATH must point to an existing .ttf font file")
        return value

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
            if (self.ai_provider == "ollama" and not self.ollama_is_local
                    and urlparse(self.ollama_url).scheme != "https"):
                raise ValueError(
                    "OLLAMA_URL must be on this computer (127.0.0.1) or use https in production, "
                    "so the assistant's data never travels unencrypted"
                )
            if self.ai_provider == "gemini" and self.gemini_free_tier:
                raise ValueError(
                    "The free Gemini API tier may use what is sent to improve Google's products "
                    "and cannot be used in production; use a paid tier (GEMINI_FREE_TIER=false) "
                    "or another AI_PROVIDER"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
