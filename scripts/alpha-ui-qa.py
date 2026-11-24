"""Browser QA for the current React Router UI in a Windows Tauri WebView."""
import base64
import json
import os
import time
import urllib.request
from pathlib import Path

import websocket

base = os.environ.get("ALPHA_URL", "http://127.0.0.1:17555").rstrip("/")
cdp_port = os.environ.get("ALPHA_CDP_PORT", "17557")
evidence_dir = Path(os.environ.get("ALPHA_EVIDENCE_DIR", "alpha-evidence"))
evidence_dir.mkdir(parents=True, exist_ok=True)
targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/list"))
target = next(
    item for item in targets
    if item.get("type") == "page" and f":{base.rsplit(':', 1)[-1]}/" in item.get("url", "")
)
ws = websocket.create_connection(target["webSocketDebuggerUrl"], suppress_origin=True, timeout=10)
sequence = 0
exceptions: list[str] = []
checks: list[str] = []


def command(method: str, params: dict | None = None) -> dict:
    global sequence
    sequence += 1
    command_id = sequence
    ws.send(json.dumps({"id": command_id, "method": method, "params": params or {}}))
    while True:
        message = json.loads(ws.recv())
        if message.get("method") == "Runtime.exceptionThrown":
            detail = message.get("params", {}).get("exceptionDetails", {})
            exceptions.append(detail.get("text", "JavaScript exception"))
        if message.get("id") == command_id:
            if message.get("error"):
                raise AssertionError(message["error"])
            return message.get("result", {})


def evaluate(expression: str):
    result = command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
    if result.get("exceptionDetails"):
        raise AssertionError(result["exceptionDetails"])
    return result.get("result", {}).get("value")


def until(expression: str, timeout: float = 20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = evaluate(expression)
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {expression}")


def screenshot(name: str):
    time.sleep(0.3)
    payload = command("Page.captureScreenshot", {"format": "png"})["data"]
    (evidence_dir / f"{name}.png").write_bytes(base64.b64decode(payload))


command("Runtime.enable")
command("Page.enable")
initial = json.loads(until(
    "JSON.stringify({url:location.href,ready:document.readyState,app:window.__RIKKAHUB_APP__===1,textarea:!!document.querySelector('textarea'),title:document.title})"
))
assert initial["ready"] == "complete" and initial["app"] and initial["textarea"], initial
body = evaluate("document.body.innerText")
assert "RikkaHub" in body and "Alpha Demo" in body, body[:500]
checks.append("Packaged Tauri WebView loads the app, navigation, demo conversation, and chat composer")
screenshot("01-tauri-home")

evaluate("(()=>{const e=document.querySelector('textarea');e.focus();return true})()")
command("Input.insertText", {"text": "Packaged Tauri UI smoke"})
command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
until("document.body.innerText.includes('Packaged Tauri UI smoke')")
until("document.querySelector('textarea')?.value === ''")
checks.append("Chat composer sends a message through the packaged Tauri app")

command("Page.navigate", {"url": base + "/settings?section=general"})
until("!!document.querySelector('[role=dialog]') && document.body.innerText.length > 100")
settings_text = evaluate("document.querySelector('[role=dialog]').innerText")
assert "设置" in settings_text or "Settings" in settings_text, settings_text[:500]
checks.append("Settings route opens and renders the current desktop settings dialog")
screenshot("02-tauri-settings")

assert not exceptions, exceptions
api_report_path = os.environ.get("ALPHA_REPORT")
api_passed = []
if api_report_path and Path(api_report_path).exists():
    api_passed = json.loads(Path(api_report_path).read_text(encoding="utf-8")).get("passed", [])
report = {"version": "0.2.1", "checks": checks, "apiChecks": api_passed, "consoleExceptions": exceptions}
(evidence_dir / "ui-qa.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
for check in checks:
    print("PASS", check, flush=True)
print(len(checks), "packaged UI checks passed;", len(api_passed), "API checks passed")
ws.close()
