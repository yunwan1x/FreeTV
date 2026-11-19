import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function setupFullscreen(status) {
  const $ = (id) => document.getElementById(id);
  const tv = { frame: $("wall"), enter: $("fullscreen"), leave: $("exitFullscreen"), status };
  const vod = {
    frame: $("vodFrame"), enter: $("vodFullscreen"), leave: $("vodExitFullscreen"),
    status: (message) => { $("vodPlayback").textContent = message; },
  };
  const android = isTauri() ? invoke("native_radio") : Promise.resolve(false);
  let active = null, pending = false, restoreWindow = false, nativeExits = 0;

  function draw(target) {
    if (active) {
      active.frame.classList.remove("fullscreen-target");
      active.leave.hidden = true;
      if (!target) active.enter.focus({ preventScroll: true });
    }
    active = target;
    document.body.classList.toggle("cinema-mode", !!target);
    if (target) {
      target.frame.classList.add("fullscreen-target");
      target.leave.hidden = false;
      target.leave.focus({ preventScroll: true });
    }
  }
  async function set(target) {
    if (pending || active === target) return;
    const player = target || active;
    const previousExits = nativeExits;
    pending = true;
    try {
      if (isTauri() && (await android)) {
        await invoke("plugin:radio|fullscreen", { enabled: !!target });
      } else if (isTauri()) {
        const win = getCurrentWindow();
        if (target) restoreWindow = !(await win.isFullscreen());
        if (restoreWindow) await win.setFullscreen(!!target);
      } else if (target) await target.frame.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
      if (previousExits === nativeExits) draw(target);
    } catch (error) {
      player.status("切换全屏失败 · " + (error.message || error));
    } finally {
      pending = false;
    }
  }
  window.addEventListener("freetv-fullscreen-exit", () => {
    nativeExits++;
    draw(null);
  });
  document.addEventListener("fullscreenchange", () => {
    if (!isTauri() && !document.fullscreenElement && active) draw(null);
  });
  document.addEventListener("keydown", (event) => {
    if (active && event.key === "Escape") {
      event.preventDefault();
      set(null);
    }
  });
  for (const player of [tv, vod]) {
    player.enter.onclick = () => set(player);
    player.leave.onclick = () => set(null);
  }
  android.then((enabled) => {
    if (!enabled) return;
    // Android WebView delegates its built-in fullscreen button to WebChromeClient.
    // Use the app buttons for both players so rotation and Back use the same path.
    for (const video of [$("tileTemplate").content.querySelector("video"), ...document.querySelectorAll("video")]) {
      video.controlsList?.add("nofullscreen");
    }
  }).catch(() => {});
  return () => set(null);
}
