"""Step 17: the production files agree with each other and stay safe.

These read the project's files only (no Docker, no database), so they run on
your PC and in CI. They are not copied into the backend test image (see
.dockerignore), because the Dockerfiles and compose file are not in it.
"""

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]+\])?==([^\s;]+)(\s*;\s*.+)?$")
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")


def _read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8-sig")


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _pins(name: str) -> dict[str, str]:
    pins: dict[str, str] = {}
    for number, raw in enumerate(_read(name).splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = PIN.match(line)
        assert match, f"{name} line {number} is not an exact pin (name==version)"
        key = _norm(match.group(1))
        assert key not in pins, f"{name} lists {match.group(1)} twice"
        pins[key] = match.group(3)
    return pins


def _compose() -> dict:
    return yaml.safe_load(_read("compose.production.yml"))


def _stages(dockerfile: str) -> list[list[str]]:
    """Instructions of each stage (continuation lines joined, comments dropped)."""
    text = re.sub(r"\\\n", " ", _read(dockerfile))
    stages: list[list[str]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.upper().startswith("FROM "):
            stages.append([])
        stages[-1].append(line)
    return stages


# --- Python lock files ---------------------------------------------------------

def test_lock_files_are_exact_and_do_not_overlap():
    runtime = _pins("requirements.lock.txt")
    test_only = _pins("requirements-test.lock.txt")
    assert runtime and test_only
    assert not set(runtime) & set(test_only)
    assert set(test_only) == {"pytest", "iniconfig", "packaging", "pluggy", "pygments"}


def test_every_requirement_has_the_same_version_in_the_lock_files():
    locked = {**_pins("requirements.lock.txt"), **_pins("requirements-test.lock.txt")}
    for name, version in _pins("requirements.txt").items():
        assert locked.get(name) == version, (
            f"{name}: requirements.txt says {version}, the lock files say {locked.get(name)}")


def test_linux_only_package_is_marked():
    line = next(l for l in _read("requirements.lock.txt").splitlines() if l.startswith("uvloop=="))
    assert 'sys_platform != "win32"' in line


# --- Dockerfiles ---------------------------------------------------------------

@pytest.mark.parametrize("dockerfile", ["backend/Dockerfile", "frontend/Dockerfile"])
def test_base_images_are_pinned_by_digest(dockerfile):
    external = [s[0].split()[1] for s in _stages(dockerfile) if ":" in s[0].split()[1]]
    assert external
    for image in external:
        assert DIGEST.search(image), f"{dockerfile}: {image} is not pinned by digest"


def test_backend_image_installs_only_the_locked_packages_and_runs_as_a_user():
    stages = _stages("backend/Dockerfile")
    base = " ".join(stages[0])
    assert "pip install --no-deps --only-binary=:all: -r requirements.lock.txt" in base
    assert "pip check" in base
    final = stages[-1]
    assert final[0].endswith("AS runtime"), "the production stage must be the last (default) one"
    users = [i.split()[1] for i in final if i.upper().startswith("USER ")]
    assert users and users[-1] not in {"root", "0"}
    cmd = next(i for i in final if i.upper().startswith("CMD "))
    assert "alembic upgrade head" in cmd and "--proxy-headers" in cmd
    test_stage = " ".join(next(s for s in stages if s[0].endswith("AS test")))
    assert "requirements-test.lock.txt" in test_stage and "pip check" in test_stage
    # The development-only demo seed is tested, but never shipped in production.
    assert "seed_demo.py" in test_stage
    assert "scripts" not in " ".join(stages[0]) + " ".join(final)


def test_website_image_runs_the_standalone_server_as_a_user():
    final = _stages("frontend/Dockerfile")[-1]
    assert "npm ci" in " ".join(_stages("frontend/Dockerfile")[0])
    assert any(i == "USER node" for i in final)
    assert any(i.startswith("COPY --from=build") and ".next/standalone" in i for i in final)
    assert final[-1] == 'CMD ["node", "server.js"]'
    assert re.search(r"HOSTNAME=0\.0\.0\.0", " ".join(final))
    assert 'output: "standalone"' in _read("frontend/next.config.ts")


def test_secrets_never_go_into_images():
    backend_ignore = [l.strip() for l in _read(".dockerignore").splitlines()
                      if l.strip() and not l.startswith("#")]
    assert backend_ignore[0] == "*", "the backend context must start from nothing"
    assert "**/.env" in backend_ignore and "**/.env.*" in backend_ignore
    frontend_ignore = [l.strip() for l in _read("frontend/.dockerignore").splitlines()]
    assert ".env" in frontend_ignore and ".env.*" in frontend_ignore and "node_modules/" in frontend_ignore


# --- compose.production.yml ----------------------------------------------------

def test_only_caddy_is_reachable_and_only_from_this_computer_by_default():
    services = _compose()["services"]
    assert set(services) == {"postgres", "backend", "web", "caddy"}
    for name in ("postgres", "backend", "web"):
        assert "ports" not in services[name], f"{name} must not publish ports"
    ports = services["caddy"]["ports"]
    assert ports == ["${PUBLISH_IP:-127.0.0.1}:80:80", "${PUBLISH_IP:-127.0.0.1}:443:443"]


def test_production_is_separate_from_development():
    compose = _compose()
    assert compose["name"] == "health11-prod"
    assert all("container_name" not in s for s in compose["services"].values())
    backend = compose["services"]["backend"]
    assert backend["environment"]["ENVIRONMENT"] == "production"
    assert backend["environment"]["DATABASE_URL"] == ""
    assert backend["environment"]["POSTGRES_HOST"] == "postgres"
    assert backend["env_file"] == [{"path": ".env.production", "required": True}]


def test_missing_secrets_stop_docker_before_anything_starts():
    services = _compose()["services"]
    assert services["postgres"]["environment"]["POSTGRES_PASSWORD"].startswith("${POSTGRES_PASSWORD:?")
    assert services["backend"]["environment"]["JWT_SECRET_KEY"].startswith("${JWT_SECRET_KEY:?")
    example = dict(
        line.split("=", 1) for line in _read(".env.production.example").splitlines()
        if line and not line.startswith("#") and "=" in line
    )
    assert example["POSTGRES_PASSWORD"] == "" and example["JWT_SECRET_KEY"] == ""
    assert example["GROQ_API_KEY"] == ""


def test_only_caddy_and_the_website_may_report_visitor_ips():
    compose = _compose()
    services = compose["services"]
    subnet = compose["networks"]["internal"]["ipam"]["config"][0]["subnet"]
    prefix = subnet.rsplit(".", 1)[0] + "."
    addresses = {name: s["networks"]["internal"]["ipv4_address"] for name, s in services.items()}
    assert all(a.startswith(prefix) for a in addresses.values())
    assert len(set(addresses.values())) == len(addresses)
    allowed = services["backend"]["environment"]["FORWARDED_ALLOW_IPS"].split(",")
    assert sorted(allowed) == sorted([addresses["caddy"], addresses["web"]])
    assert services["web"]["environment"]["TRUST_PROXY_HEADERS"] == "true"


def test_caddy_image_is_pinned_and_services_have_health_checks():
    services = _compose()["services"]
    assert DIGEST.search(services["caddy"]["image"])
    assert services["postgres"]["image"].startswith("postgres:16.6@sha256:")
    assert DIGEST.search(services["postgres"]["image"])
    for name in ("postgres", "backend", "web"):
        assert "healthcheck" in services[name]
    assert services["caddy"]["depends_on"] == {"web": {"condition": "service_healthy"}}


def test_example_settings_are_all_known():
    from app.config import Settings

    compose_only = {"SITE_HOST", "CADDY_TLS", "PUBLISH_IP"}
    for line in _read(".env.production.example").splitlines():
        line = line.lstrip("# ").strip()
        match = re.match(r"^([A-Z][A-Z0-9_]+)=", line)
        if match:
            key = match.group(1)
            assert key in compose_only or key.lower() in Settings.model_fields, f"unknown setting {key}"


# --- Caddy, git, scripts -------------------------------------------------------

def test_caddy_sends_only_live_streams_to_the_api():
    caddyfile = _read("deploy/Caddyfile")
    assert re.search(r"@stream path /api/v1/ws/\*", caddyfile)
    upstreams = re.findall(r"reverse_proxy\s+(\S+)", caddyfile)
    assert upstreams == ["backend:8000", "web:3000"]
    assert "tls {$CADDY_TLS}" in caddyfile


def test_git_ignores_production_secrets_and_backups():
    rules = [l.strip() for l in _read(".gitignore").splitlines()]
    assert ".env.*" in rules and "!.env.production.example" in rules and "backups/" in rules


@pytest.mark.parametrize("script", ["scripts/backup.ps1", "scripts/restore.ps1",
                                    "scripts/new-production-secrets.ps1"])
def test_scripts_work_in_windows_powershell(script):
    data = (ROOT / script).read_bytes()
    # Windows PowerShell 5.1 reads files without a BOM as the local code page.
    assert data.isascii(), f"{script} must contain only ASCII characters"
    text = data.decode("ascii")
    assert ".env.production" in text
    assert "docker-compose.yml" not in text, "the scripts must never touch the development database"


def test_secrets_script_never_shows_or_replaces_a_secret():
    text = _read("scripts/new-production-secrets.ps1")
    assert "RandomNumberGenerator" in text
    # Only empty values are filled; a set password is kept.
    assert 'already has a value: kept' in text
    for line in text.splitlines():
        if "Write-Host" in line or "Write-Output" in line:
            assert "New-Secret" not in line and "$lines[" not in line


def test_restore_asks_first_and_keeps_a_safety_backup():
    text = _read("scripts/restore.ps1")
    ask = text.index("Read-Host")
    assert "-cne 'RESTORE'" in text
    assert ask < text.index("backup.ps1') -Label 'before-restore'") < text.index("dropdb")
    assert "--exit-on-error" in text
