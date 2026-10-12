import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import URL, create_engine, make_url, pool

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base  # noqa: E402
import app.models  # noqa: F401, E402

target_metadata = Base.metadata

# Values already present in the environment win over .env (load_dotenv does
# not override), so a shell can point Alembic at the test database with
# DATABASE_URL without editing any file.
load_dotenv(PROJECT_ROOT / ".env")


def _database_url() -> URL:
    explicit_url = os.environ.get("DATABASE_URL")
    if explicit_url:
        return make_url(explicit_url)

    required_vars = ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD")
    missing_vars = [name for name in required_vars if not os.environ.get(name)]
    if missing_vars:
        raise RuntimeError(
            "Set DATABASE_URL, or set these variables in .env: "
            + ", ".join(missing_vars)
        )

    return URL.create(
        drivername="postgresql+psycopg",
        username=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        port=int(os.environ.get("POSTGRES_PORT", "5433")),
        database=os.environ["POSTGRES_DB"],
    )


database_url = _database_url()

# Always show which database is about to change (never the password).
print(
    f"Alembic target database: {database_url.host}:{database_url.port}"
    f"/{database_url.database}",
    file=sys.stderr,
)


def run_migrations_offline() -> None:
    context.configure(
        url=database_url.render_as_string(hide_password=True),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(database_url, poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()

    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
