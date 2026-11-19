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
    def evaluate(expression):
        nonlocal sequence
        sequence += 1
        ws.send(json.dumps({"id": sequence, "method": "Runtime.evaluate",
                            "params": {"expression": expression, "returnByValue": True, "userGesture": True}}))
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == sequence:
                result = message["result"]
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
    clip = Path(folder) / "test.m3u8"
    subprocess.run([shutil.which("ffmpeg") or "ffmpeg", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=256x144:rate=10", "-t", "90",
                    "-c:v", "libx264", "-preset", "ultrafast", "-g", "20",
                    "-hls_time", "2", "-hls_list_size", "0", str(clip)], check=True)
    channel = {"id": "pip-test", "name": "PiP test", "group": "央视", "region": "CN",
               "logo": "", "epg_id": "", "routes": ["http://127.0.0.1:8791/test.m3u8"]}
    seed = {"radio-favorites": [[station["stationuuid"], station]],
            **{f"feed-{i}": {"channels": [channel] if i == 0 else [],
                             "updated": int(time.time() * 1000)} for i in range(3)}}
    evaluate("for(const [k,v] of Object.entries(" + json.dumps(seed) +
             ")) localStorage.setItem(k,JSON.stringify(v));location.reload()")
    wait(lambda: evaluate("document.querySelector('.screen h2')?.textContent==='PiP test'"))
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
    evaluate("document.querySelector('#home').click();document.querySelector('.screen-play').click()")
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
