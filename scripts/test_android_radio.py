"""Drive the debug APK, then use Android media keys while its display is asleep."""
import json
import re
import subprocess
import sys
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
    def evaluate(expression):
        nonlocal sequence
        sequence += 1
        ws.send(json.dumps({"id": sequence, "method": "Runtime.evaluate",
                            "params": {"expression": expression, "returnByValue": True}}))
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == sequence:
                result = message["result"]
                if "exceptionDetails" in result:
                    raise AssertionError(result["exceptionDetails"])
                return result["result"].get("value")
    station = {"stationuuid":"screen-off-test","name":"Screen-off test","countrycode":"GB",
               "url":"http://127.0.0.1:8791/radio.wav","url_resolved":"","hls":0,"codec":"PCM","language":""}
    evaluate("localStorage.setItem('radio-favorites', " + json.dumps(json.dumps([[station["stationuuid"],station]])) + ");location.reload()")
    time.sleep(1)
    wait(lambda: evaluate("!!document.querySelector('#radioNav')"))
    evaluate("document.querySelector('#radioNav').click();document.querySelector('#radioFavs').click()")
    wait(lambda: evaluate("!!document.querySelector('.radio-station')"))
    evaluate("document.querySelector('.radio-station').click()")
    wait(is_playing)
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
