"""Optional live smoke test; requires the official `openai` Python package.

API_BASE_URL=http://127.0.0.1:8088/v1 python3 tests/sdk-smoke.py
API_BASE_URL=http://127.0.0.1:8089/v1 python3 tests/sdk-smoke.py
"""

import json
import os

import openai
from openai import OpenAI

base_url = os.environ.get("API_BASE_URL", "http://127.0.0.1:8088/v1")
model = os.environ.get("MODEL", "huggingface.co/mlx-community/qwen3-0.6b-4bit:latest")
client = OpenAI(base_url=base_url, api_key="local", timeout=180, max_retries=0)
prompt = "Reply with exactly one word: ready"

response = client.responses.create(model=model, input=prompt, store=False, max_output_tokens=256)
assert response.status in ("completed", "incomplete"), response.status
assert response.output_text.strip(), "Responses JSON returned no output text"

deltas = []
with client.responses.stream(model=model, input=prompt, store=False, max_output_tokens=256) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            deltas.append(event.delta)
    final = stream.get_final_response()
assert final.status in ("completed", "incomplete"), final.status
assert final.output_text.strip(), "Responses stream returned no output text"
assert "".join(deltas) == final.output_text, "SDK stream text disagrees with final response"

chat = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": prompt}],
    max_tokens=256,
    stream=True,
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)
chat_text = "".join(chunk.choices[0].delta.content or "" for chunk in chat if chunk.choices)
assert chat_text.strip(), "Chat stream returned no output text"

print(json.dumps({
    "sdk": f"openai-python {openai.__version__}",
    "base_url": base_url,
    "responses_json": {"status": response.status, "output_text": response.output_text},
    "responses_stream": {"status": final.status, "output_text": final.output_text, "delta_count": len(deltas)},
    "chat_stream": {"output_text": chat_text},
}, ensure_ascii=False, indent=2))
