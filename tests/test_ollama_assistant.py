"""The AI assistant with a local model (AI_PROVIDER=ollama) and the quota message.

Ollama is never really called: requests go to httpx.MockTransport, which plays
the documented /api/chat answers (https://ollama.com/blog/structured-outputs).
"""

import json

import httpx
import pytest
from app.assistant_api import get_language_model
from app.main import app
from app.services import assistant

from tests.test_phase7_assistant import (  # noqa: F401  (fixtures)
    Site,
    client,
    model,
    scenario_reply,
    settings,
)


def ollama(*answers, timeout=60):
    """An OllamaModel whose HTTP calls get scripted answers; records the requests."""
    requests = []

    def handler(request):
        requests.append(request)
        answer = answers[min(len(requests), len(answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        return httpx.Response(status, json=body) if not isinstance(body, str) else httpx.Response(status, text=body)

    llm = assistant.OllamaModel("http://127.0.0.1:11434/", "llama3.2", timeout=timeout,
                                transport=httpx.MockTransport(handler))
    return llm, requests


def chat(content, done_reason="stop"):
    return 200, {"model": "llama3.2", "message": {"role": "assistant", "content": content},
                 "done": True, "done_reason": done_reason}


def test_sends_a_documented_structured_output_request():
    llm, requests = ollama(chat('{"summary": "ok"}'))
    assert llm.complete_json("SYSTEM", "USER", assistant.SUMMARY_SCHEMA, 800) == {"summary": "ok"}
    request = requests[0]
    assert (request.method, str(request.url)) == ("POST", "http://127.0.0.1:11434/api/chat")
    body = json.loads(request.content)
    assert body["model"] == "llama3.2" and body["stream"] is False
    assert body["format"] == assistant.SUMMARY_SCHEMA                    # structured outputs
    assert body["options"] == {"temperature": 0, "num_predict": 800}
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert body["messages"][0]["content"].startswith("SYSTEM")
    assert body["messages"][1]["content"] == "USER"                      # the user's text stays data
    assert "authorization" not in request.headers                       # no key goes anywhere
    assert llm._direct                                                   # never through a proxy
    assert not assistant.OllamaModel("https://ai.example.org", "m", timeout=5)._direct


def test_thinking_before_the_answer_is_ignored():
    llm, _ = ollama(chat('<think>The ward is on floor 1.</think>\n{"summary": "ok"}'))
    assert llm.complete_json("S", "U", {}, 10) == {"summary": "ok"}


@pytest.mark.parametrize("answer, status, words", [
    (httpx.ConnectError("refused"), 503, "The local AI (Ollama) is not running; start the Ollama app"),
    (httpx.ReadTimeout("slow"), 503, "did not answer in time"),
    ((404, {"error": "model 'llama3.2' not found"}), 503, "not installed; run: ollama pull llama3.2"),
    ((500, {"error": "out of memory"}), 502, "returned an error (500)"),
    (chat('{"summary": "cut off', done_reason="length"), 502, "could not complete an answer"),
    (chat("not json at all"), 502, "unexpected format"),
    ((200, "<html>proxy page</html>"), 502, "unexpected format"),
    ((200, {"done": True}), 502, "unexpected format"),
])
def test_problems_become_clear_messages(answer, status, words):
    llm, _ = ollama(answer)
    with pytest.raises(assistant.AssistantError) as raised:
        llm.complete_json("S", "U", {}, 10)
    assert raised.value.status_code == status and words in str(raised.value)


def test_the_reason_is_kept_for_the_log_and_the_setup_check():
    llm, _ = ollama((500, {"error": "out of memory"}))
    with pytest.raises(assistant.AssistantError) as raised:
        llm.complete_json("S", "U", {}, 10)
    assert raised.value.detail == "HTTP 500 | out of memory"
    slow, _ = ollama(httpx.ReadTimeout("slow"), timeout=180)
    with pytest.raises(assistant.AssistantError) as raised:
        slow.complete_json("S", "U", {}, 10)
    assert raised.value.detail == "ReadTimeout after 180 s (OLLAMA_TIMEOUT_SECONDS)"


def test_settings_pick_ollama_and_explain_what_is_missing():
    chosen = assistant.configured_model(settings(ai_provider="Ollama", ollama_model="llama3.2"))
    assert isinstance(chosen, assistant.OllamaModel)
    assert chosen._url == "http://127.0.0.1:11434/api/chat" and chosen._timeout == 180
    with pytest.raises(assistant.AssistantError) as raised:
        assistant.configured_model(settings(ai_provider="ollama"))
    assert raised.value.status_code == 503 and "OLLAMA_MODEL" in str(raised.value)
    assert assistant.data_notice(settings(ai_provider="ollama", ollama_model="m")) is None   # nothing leaves the PC
    with pytest.raises(ValueError, match="AI_PROVIDER must be anthropic, gemini, groq or ollama"):
        settings(ai_provider="openai")


@pytest.mark.parametrize("url", ["127.0.0.1:11434", "ftp://127.0.0.1", "http://127.0.0.1:11434/api/chat",
                                 "http://", "http://host?x=1"])
def test_ollama_url_must_be_a_plain_address(url):
    with pytest.raises(ValueError, match="OLLAMA_URL"):
        settings(ollama_url=url)


def test_production_keeps_local_model_data_off_unencrypted_networks():
    production = {"environment": "production", "jwt_secret_key": "p" * 40,
                  "database_url": "postgresql+psycopg://u:strong@db:5432/health11",
                  "ai_provider": "ollama", "ollama_model": "llama3.2"}
    with pytest.raises(ValueError, match="OLLAMA_URL must be on this computer"):
        settings(ollama_url="http://10.0.0.5:11434", **production)
    assert settings(ollama_url="http://127.0.0.1:11434", **production).ollama_is_local
    assert settings(ollama_url="https://ai.example.org", **production).ai_provider == "ollama"
    assert settings(ollama_url="http://10.0.0.5:11434", ai_provider="ollama").ollama_url   # fine in development


def test_the_whole_assistant_works_through_a_local_model(client, db_session):  # noqa: F811
    site = Site(client, db_session, "Local AI Org")
    draft = json.dumps(scenario_reply(("Ward A", "fire", 3, 2)))
    local, requests = ollama(chat(draft))
    app.dependency_overrides[get_language_model] = lambda: local
    response = site.ask("fire in ward a, spreading slowly")
    assert response.status_code == 200, response.text
    hazard = response.json()["scenario"]["hazards"][0]
    assert (hazard["origin_node_id"], hazard["type"], hazard["severity"]) == (site.ids["Ward A"], "fire", 3)
    assert response.json()["data_notice"] is None
    # The model saw only the floor's place names and the text, as with the other providers.
    sent = json.loads(json.loads(requests[0].content)["messages"][1]["content"])
    assert set(sent["floor_node_names"]) == {"Ward A", "Corridor 1", "Exit 1"}

    # Ollama not running: a clear 503 for the page.
    down, _ = ollama(httpx.ConnectError("refused"))
    app.dependency_overrides[get_language_model] = lambda: down
    refused = site.ask("fire in ward a")
    assert refused.status_code == 503
    assert refused.json()["error"]["message"] == "The local AI (Ollama) is not running; start the Ollama app"


# --- Quota message (found with a free Gemini key on 13 October 2026) -------------------------

def test_a_used_up_quota_is_not_called_busy():
    from tests.test_phase7_assistant import gemini, google_error

    llm, _, _ = gemini(google_error(429, "RESOURCE_EXHAUSTED",
                                      "Your project has exceeded a quota. See https://ai.dev/rate-limit"))
    with pytest.raises(assistant.AssistantError) as raised:
        llm.complete_json("S", "U", {}, 10)
    assert raised.value.status_code == 503 and str(raised.value) == assistant.QUOTA_MESSAGE
    busy, _, _ = gemini(google_error(429, "RESOURCE_EXHAUSTED", "Too many requests, slow down"))
    with pytest.raises(assistant.AssistantError) as raised:
        busy.complete_json("S", "U", {}, 10)
    assert str(raised.value) == "The AI service is busy; try again in a minute"
