"""One real call to the configured AI service, to check the AI assistant is set up.

Run from the project folder:
    .\\.venv\\Scripts\\python.exe scripts\\check_assistant.py

It reads AI_PROVIDER and that provider's key and model from .env, sends one short
made-up request (no database, no patient data) and checks that the answer
passes the same checks the API uses. The key is never printed.
Each run is one API request (billed, or counted against a free-tier limit);
with AI_PROVIDER=ollama it runs on this computer and costs nothing.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.config import get_settings  # noqa: E402
from app.services import assistant  # noqa: E402

FLOOR = [assistant.FloorNode(id=1, name="Ward A"), assistant.FloorNode(id=2, name="Corridor 1"),
         assistant.FloorNode(id=3, name="Exit North")]
TEXT = "Fire in ward a, severity 3, spreading about 2 metres per minute."


def main() -> int:
    settings = get_settings()
    provider = settings.ai_provider
    secret = {"gemini": settings.gemini_api_key, "anthropic": settings.anthropic_api_key}.get(provider)
    if secret and secret.get_secret_value().startswith("replace_with"):
        print(f"FAILED: {provider.upper()}_API_KEY in .env is still the placeholder")
        return 1
    try:
        model = assistant.configured_model(settings)
    except assistant.AssistantError as exc:
        print(f"FAILED: {exc}")
        return 1
    if provider == "ollama":
        print(f"Provider: ollama, model: {settings.ollama_model}, on {settings.ollama_url}  (runs on this "
              f"computer; no API key; answers can take a minute, limit {settings.ollama_timeout_seconds:g} s)")
    else:
        name = settings.gemini_model if provider == "gemini" else settings.anthropic_model
        version = f", API version: {settings.gemini_api_version}" if provider == "gemini" else ""
        print(f"Provider: {provider}, model: {name}{version}  (API key loaded from .env, not shown)")
    notice = assistant.data_notice(settings)
    if notice:
        print(f"Note: {notice}")
    try:
        reply = model.complete_json(
            system=assistant.DRAFT_SYSTEM_PROMPT,
            user_content=assistant.draft_request_content(TEXT, [n.name for n in FLOOR]),
            schema=assistant.DRAFT_SCHEMA, max_tokens=1500)
        result = assistant.interpret_draft(reply, FLOOR)
    except assistant.AssistantError as exc:
        print(f"FAILED: {exc}")
        if exc.detail:
            print(f"Reason given by the AI service: {exc.detail}")
        return 1

    if "scenario" not in result:
        print(f"FAILED: expected a scenario, got a question instead: {result['clarification']}")
        return 1
    hazard = result["scenario"]["hazards"][0]
    print(f"Draft: {hazard['name']}, severity {hazard['severity']}, "
          f"{hazard['spread_rate']} m/min (place id {hazard['origin_node_id']})")
    if (hazard["origin_node_id"], hazard["type"], hazard["severity"]) != (1, "fire", 3):
        print("FAILED: the draft does not match the request")
        return 1
    print("PASSED: the AI assistant is working")
    return 0


if __name__ == "__main__":
    sys.exit(main())
