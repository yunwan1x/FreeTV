import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function setupFullscreen(status) {
  const wall = document.getElementById("wall");
  const enter = document.getElementById("fullscreen");
  const leave = document.getElementById("exitFullscreen");
  const android = isTauri() ? invoke("native_radio") : Promise.resolve(false);
  let active = false,
    pending = false,
    restoreWindow = false;
  function draw(enabled) {
    active = enabled;
    document.body.classList.toggle("cinema-mode", enabled);
    leave.hidden = !enabled;
    (enabled ? leave : enter).focus({ preventScroll: true });
  }
  async function set(enabled) {
    if (pending || active === enabled) return;
    pending = true;
    try {
      if (isTauri() && (await android)) {
        await invoke("plugin:radio|fullscreen", { enabled });
      } else if (isTauri()) {
        const win = getCurrentWindow();
        if (enabled) restoreWindow = !(await win.isFullscreen());
        if (restoreWindow) await win.setFullscreen(enabled);
      } else if (enabled) await wall.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
      draw(enabled);
    } catch (error) {
      status("切换全屏失败 · " + (error.message || error));
    } finally {
      pending = false;
    }
  }
  window.addEventListener("freetv-fullscreen-exit", () => draw(false));
  document.addEventListener("fullscreenchange", () => {
    if (!isTauri() && !document.fullscreenElement && active) draw(false);
  });
  document.addEventListener("keydown", (event) => {
    if (active && event.key === "Escape") {
      event.preventDefault();
      set(false);
    }
  });
  enter.onclick = () => set(true);
  leave.onclick = () => set(false);
  return () => set(false);
}
