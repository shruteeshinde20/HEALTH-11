from functools import lru_cache
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "HEALTH-11"
    environment: str = "development"
    api_v1_prefix: str = "/api/v1"
    database_url: str = "postgresql+psycopg://health11:replace_me@127.0.0.1:5433/health11"
    jwt_secret_key: str = "development-only-change-this-secret-before-production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

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
                raise ValueError("JWT_SECRET_KEY must be at least 32 characters in production")
            if self.jwt_secret_key == "development-only-change-this-secret-before-production":
                raise ValueError("Set a unique JWT_SECRET_KEY in production")
            if "replace_me" in self.database_url.lower():
                raise ValueError("Set DATABASE_URL in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
