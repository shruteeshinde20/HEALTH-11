# HEALTH-11 API (FastAPI) for production. Build from the project folder:
#   docker build -f backend/Dockerfile -t health11-backend .
# compose.production.yml does this for you.
#
# The base image is pinned by its digest (checked with docker pull in step 17),
# so a rebuild always starts from exactly the same Python 3.11.9.

FROM python:3.11.9-slim-bookworm@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Exactly the locked versions, only ready-made packages (nothing compiled),
# and nothing pip would add on its own; "pip check" then proves the set is complete.
COPY requirements.lock.txt ./
RUN pip install --no-deps --only-binary=:all: -r requirements.lock.txt \
 && pip check

# The API runs as an ordinary user, not root. It may write only its model folder.
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin health11 \
 && mkdir -p /app/var/models \
 && chown health11:health11 /app/var/models

COPY alembic.ini ./
COPY alembic ./alembic
COPY backend ./backend

# Test image: the same packages plus pytest, and the test suite. Used to prove
# the locked Linux versions pass every backend test (they run against
# health11_test, never the live database):
#   docker build -f backend/Dockerfile --target test -t health11-backend-test .
FROM base AS test
USER root
COPY requirements-test.lock.txt ./
RUN pip install --no-deps --only-binary=:all: -r requirements-test.lock.txt \
 && pip check
COPY tests ./tests
COPY scripts/seed_demo.py scripts/reset_password.py ./scripts/
USER health11
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"]


# The production image (the last stage, so a plain docker build makes this one).
FROM base AS runtime
USER health11
EXPOSE 8000

# 1) bring the database up to date (Alembic prints the target, never the password),
# 2) start the API. --proxy-headers: the real visitor IP comes from the website
# and Caddy, but only from the addresses in FORWARDED_ALLOW_IPS (set in
# compose.production.yml); anyone else's X-Forwarded-For is ignored.
CMD ["sh", "-c", "python -m alembic upgrade head && exec python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000 --proxy-headers --no-server-header"]
