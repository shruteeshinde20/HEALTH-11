"""The AI assistant with Groq (AI_PROVIDER=groq).

Groq is never really called: requests go to httpx.MockTransport, which plays
OpenAI-compatible chat completion answers (https://api.groq.com/openai/v1/).
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

KEY = "gsk_test_secret_key"


def groq(*answers, retries=2):
    """A GroqModel whose HTTP calls get scripted answers; records requests and waits."""
    requests, waits = [], []

    def handler(request):
        requests.append(request)
        answer = answers[min(len(requests), len(answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        return httpx.Response(status, json=body) if not isinstance(body, str) else httpx.Response(status, text=body)

    llm = assistant.GroqModel(KEY, "openai/gpt-oss-20b", timeout=9, max_retries=retries,
                              transport=httpx.MockTransport(handler), sleep=waits.append)
    return llm, requests, waits


def completion(content, finish_reason="stop", **message):
    return 200, {"id": "chatcmpl-1", "object": "chat.completion", "model": "openai/gpt-oss-20b",
                 "choices": [{"index": 0, "finish_reason": finish_reason,
                              "message": {"role": "assistant", "content": content, **message}}]}


def failure(status, message, code=None):
    return status, {"error": {"message": message, "type": "invalid_request_error", "code": code}}


def test_sends_an_openai_compatible_strict_structured_output_request():
    llm, requests, _ = groq(completion('{"summary": "ok"}'))
    assert llm.complete_json("SYSTEM", "USER", assistant.SUMMARY_SCHEMA, 800) == {"summary": "ok"}
    request = requests[0]
    assert (request.method, str(request.url)) == ("POST", "https://api.groq.com/openai/v1/chat/completions")
    assert request.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(request.content)
    assert body["model"] == "openai/gpt-oss-20b"
    assert body["messages"] == [{"role": "system", "content": "SYSTEM"}, {"role": "user", "content": "USER"}]
    assert body["response_format"] == {"type": "json_schema", "json_schema": {
        "name": "answer", "strict": True, "schema": assistant.SUMMARY_SCHEMA}}
    assert body["max_completion_tokens"] == 800 + assistant.GROQ_REASONING_ROOM


@pytest.mark.parametrize("answer, status, words", [
    (failure(401, "Invalid API Key", "invalid_api_key"), 503, "check GROQ_API_KEY"),
    (failure(404, "The model `x` does not exist", "model_not_found"), 503, "check GROQ_MODEL"),
    (failure(400, "Bad request"), 502, "returned an error (400)"),
    (failure(429, "Rate limit reached for model on tokens per day (TPD): Limit 100000, Used 100000",
             "rate_limit_exceeded"), 503, "usage limit (quota)"),
    (completion('{"summary": "cut', finish_reason="length"), 502, "could not complete an answer"),
    (completion(None, refusal="I can't help with that"), 502, "could not complete an answer"),
    (completion("not json"), 502, "unexpected format"),
    ((200, {"choices": []}), 502, "unexpected format"),
    ((200, "<html>proxy</html>"), 502, "unexpected format"),
])
def test_problems_become_clear_messages_without_retrying(answer, status, words):
    llm, requests, _ = groq(answer)
    with pytest.raises(assistant.AssistantError) as raised:
        llm.complete_json("S", "U", {}, 10)
    assert raised.value.status_code == status and words in str(raised.value)
    assert len(requests) == 1                     # a used-up daily limit is not hammered


@pytest.mark.parametrize("answer, words", [
    (failure(429, "Rate limit reached: requests per minute (RPM)", "rate_limit_exceeded"), "busy"),
    (failure(503, "Service unavailable"), "temporarily unavailable"),
    (httpx.ReadTimeout("slow"), "did not answer in time"),
    (httpx.ConnectError("no route"), "could not be reached"),
])
def test_temporary_failures_are_retried_then_explained(answer, words):
    llm, requests, waits = groq(answer)
    with pytest.raises(assistant.AssistantError) as raised:
        llm.complete_json("S", "U", {}, 10)
    assert raised.value.status_code == 503 and words in str(raised.value)
    assert len(requests) == 3 and waits == [1, 2]


def test_a_retry_that_succeeds_is_used():
    llm, requests, _ = groq(failure(503, "busy"), completion('{"summary": "ok"}'))
    assert llm.complete_json("S", "U", {}, 10) == {"summary": "ok"} and len(requests) == 2


def test_the_key_never_appears_in_errors():
    llm, _, _ = groq(failure(400, f"Bad key {KEY} sent"))
    with pytest.raises(assistant.AssistantError) as raised:
        llm.complete_json("S", "U", {}, 10)
    assert KEY not in str(raised.value) and KEY not in raised.value.detail and "[hidden]" in raised.value.detail


def test_settings_pick_groq_and_explain_what_is_missing():
    chosen = assistant.configured_model(settings(ai_provider="groq", groq_api_key=KEY, groq_model="openai/gpt-oss-20b"))
    assert isinstance(chosen, assistant.GroqModel)
    for missing in ({"groq_model": "m"}, {"groq_api_key": KEY}):
        with pytest.raises(assistant.AssistantError) as raised:
            assistant.configured_model(settings(ai_provider="groq", **missing))
        assert raised.value.status_code == 503 and "GROQ_API_KEY and GROQ_MODEL" in str(raised.value)
    assert KEY not in repr(settings(groq_api_key=KEY))              # SecretStr hides the key


def test_the_whole_assistant_works_through_groq(client, db_session):  # noqa: F811
    site = Site(client, db_session, "Groq Org")
    llm, requests, _ = groq(completion(json.dumps(scenario_reply(("Ward A", "fire", 4, 2)))))
    app.dependency_overrides[get_language_model] = lambda: llm
    response = site.ask("fire in ward a, severity 4")
    assert response.status_code == 200, response.text
    hazard = response.json()["scenario"]["hazards"][0]
    assert (hazard["origin_node_id"], hazard["severity"]) == (site.ids["Ward A"], 4)
    sent = json.loads(json.loads(requests[0].content)["messages"][1]["content"])
    assert set(sent["floor_node_names"]) == {"Ward A", "Corridor 1", "Exit 1"}   # only this floor's names
