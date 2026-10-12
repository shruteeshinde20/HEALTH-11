"""One real call to the Anthropic API, to check the AI assistant is set up.

Run from the project folder:
    .\\.venv\\Scripts\\python.exe scripts\\check_assistant.py

It reads ANTHROPIC_API_KEY and ANTHROPIC_MODEL from .env, sends one short
made-up request (no database, no patient data) and checks that the answer
passes the same checks the API uses. The key is never printed.
Each run is one billed API request.
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
    key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else ""
    if not key or key.startswith("replace_with"):
        print("FAILED: ANTHROPIC_API_KEY is not set in .env")
        return 1
    if not settings.anthropic_model:
        print("FAILED: ANTHROPIC_MODEL is not set in .env")
        return 1
    print(f"Model: {settings.anthropic_model}  (API key loaded from .env, not shown)")

    try:
        model = assistant.AnthropicModel(key, settings.anthropic_model,
                                         timeout=settings.assistant_timeout_seconds)
    except ImportError:
        print("FAILED: the anthropic package is not installed; run pip install -r requirements.txt")
        return 1
    try:
        reply = model.complete_json(
            system=assistant.DRAFT_SYSTEM_PROMPT,
            user_content=assistant.draft_request_content(TEXT, [n.name for n in FLOOR]),
            schema=assistant.DRAFT_SCHEMA, max_tokens=1500)
        result = assistant.interpret_draft(reply, FLOOR)
    except assistant.AssistantError as exc:
        print(f"FAILED: {exc}")
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
