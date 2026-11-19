"""Drive the debug APK, then use Android media keys while its display is asleep."""
import json
import re
import subprocess
import sys
import shutil
import threading
import time
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import urlopen

import websocket

PACKAGE = "app.freetv.player"


def adb(*args):
    return subprocess.check_output(["adb", *args], text=True, timeout=30).strip()


def wait(check, seconds=35):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.5)
    raise AssertionError(f"Timed out waiting for {check.__name__}")


def is_playing():
    return session_state() == 3


def session_state():
    dump = adb("shell", "dumpsys", "media_session")
    for section in re.split(r"(?=\bpackage=)", dump):
        if section.startswith("package=" + PACKAGE):
            state = re.search(r"state=PlaybackState\s*\{state=(?:\w+\()?([0-9]+)", section)
            if state:
                return int(state[1])
    return None


def test(folder):
    # A deterministic three-minute audio source, long enough to exercise screen-off.
    with wave.open(str(Path(folder) / "radio.wav"), "wb") as media:
        media.setparams((1, 2, 8000, 0, "NONE", ""))
        media.writeframes(bytes(2 * 8000 * 180))
    server = ThreadingHTTPServer(("127.0.0.1", 8791), partial(SimpleHTTPRequestHandler, directory=folder))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    apk, = Path("emulator-apk").rglob("*debug.apk")
    adb("install", "-r", str(apk))
    adb("reverse", "tcp:8791", "tcp:8791")
    adb("shell", "am", "start", "-n", PACKAGE + "/.MainActivity")
    wait(lambda: "webview_devtools_remote_" in adb("shell", "cat", "/proc/net/unix"))
    pid = adb("shell", "pidof", PACKAGE).split()[0]
    port = adb("forward", "tcp:0", "localabstract:webview_devtools_remote_" + pid)
    def target():
        try:
            tabs = json.load(urlopen(f"http://127.0.0.1:{port}/json", timeout=5))
            return next((t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page"), None)
        except OSError:
            return None
    wait(target)
    ws = websocket.create_connection(target(), timeout=10, suppress_origin=True)
    sequence = 0
    def command(method, params):
        nonlocal sequence
        sequence += 1
        ws.send(json.dumps({"id": sequence, "method": method, "params": params}))
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == sequence:
                if "error" in message:
                    raise AssertionError(message["error"])
                return message["result"]
    def evaluate(expression):
        result = command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "userGesture": True})
        if "exceptionDetails" in result:
            raise AssertionError(result["exceptionDetails"])
        return result["result"].get("value")
    station = {"stationuuid":"screen-off-test","name":"Screen-off test","countrycode":"GB",
               "url":"http://127.0.0.1:8791/radio.wav","url_resolved":"","hls":0,"codec":"PCM","language":""}
    try:
        wait(lambda: evaluate("!!document.querySelector('#radioNav')?.onclick"))
    except AssertionError:
        print("WebView:", evaluate("[location.href,document.readyState,document.body?.innerText?.slice(0,320)]"), file=sys.stderr)
        raise
    shutil.copyfile(Path(__file__).with_name("test-pattern.mp4"), Path(folder) / "test.mp4")
    channel = {"id": "pip-test", "name": "PiP test", "group": "央视", "region": "CN",
               "logo": "", "epg_id": "", "routes": ["http://127.0.0.1:8791/test.mp4"]}
    seed = {"radio-favorites": [[station["stationuuid"], station]],
            **{f"feed-{i}": {"channels": [channel] if i == 0 else [],
                             "updated": int(time.time() * 1000)} for i in range(3)}}
    seed["auto-sync"] = False
    seed["lastChannel"] = channel["id"]
    command("Page.enable", {})
    command("Page.addScriptToEvaluateOnNewDocument", {"source":
        "for(const [k,v] of Object.entries(" + json.dumps(seed) +
        "))localStorage.setItem(k,JSON.stringify(v));window.__fixture=true;"})
    command("Page.reload", {"ignoreCache": True})
    try:
        wait(lambda: evaluate("window.__fixture===true && !!document.querySelector('#radioNav')?.onclick"))
    except AssertionError:
        print("Fixture state:", evaluate("[location.href,document.readyState,window.__fixture,document.body?.innerText.slice(0,600)]"), file=sys.stderr)
        raise
    print("Test page ready:", evaluate("[location.href,document.querySelector('#now')?.innerText,localStorage.getItem('lastChannel')]"), flush=True)
    evaluate("document.querySelector('#radioNav').click();document.querySelector('#radioFavs').click()")
    wait(lambda: evaluate("!!document.querySelector('.radio-station')"))
    evaluate("document.querySelector('.radio-station').click()")
    try:
        wait(is_playing)
    except AssertionError:
        print("Radio status:", evaluate("document.querySelector('#radioStatus').innerText"), file=sys.stderr)
        raise
    adb("shell", "input", "keyevent", "KEYCODE_SLEEP")
    wait(lambda: "mWakefulness=Asleep" in adb("shell", "dumpsys", "power"))
    time.sleep(12)
    assert is_playing(), "Radio stopped after display sleep"
    services = adb("shell", "dumpsys", "activity", "services", PACKAGE)
    assert "RadioService" in services and "isForeground=true" in services, services
    adb("shell", "input", "keyevent", "KEYCODE_MEDIA_PAUSE")
    wait(lambda: session_state() == 2)
    adb("shell", "input", "keyevent", "KEYCODE_MEDIA_PLAY")
    wait(is_playing)
    print("Verified native playback, foreground service, screen-off playback and media-key pause/resume.")
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    adb("shell", "wm", "dismiss-keyguard")
    evaluate("document.querySelector('#home').click()")
    print("TV state:", evaluate("[document.querySelector('#now')?.innerText,document.querySelector('#channels')?.innerText.slice(0,240)]"), flush=True)
    evaluate("document.querySelector('#channels [data-i=pip-test]').click()")
    wait(lambda: evaluate("document.querySelector('.screen video').currentTime > 1"))
    evaluate("document.querySelector('#fullscreen').click()")
    wait(lambda: evaluate("document.body.classList.contains('cinema-mode')"))
    adb("shell", "input", "keyevent", "KEYCODE_BACK")
    wait(lambda: evaluate("!document.body.classList.contains('cinema-mode')"))
    print("Verified Android fullscreen and system Back.")
    evaluate("document.querySelector('#pip').click()")
    def pinned():
        return re.search(r"mode=pinned[^\n]*", adb("shell", "dumpsys", "activity", "activities")) is not None
    wait(pinned)
    start = evaluate("document.querySelector('.screen video').currentTime")
    wait(lambda: evaluate("document.querySelector('.screen video').currentTime") > start + 2)
    print("Verified Android system PiP with advancing video.")
    ws.close()
    server.shutdown()


if __name__ == "__main__":
    try:
        with TemporaryDirectory() as folder:
            test(folder)
    except Exception:
        print(adb("shell", "dumpsys", "media_session")[-9000:], file=sys.stderr)
        print(adb("logcat", "-d", "-t", "300")[-12000:], file=sys.stderr)
        raise
