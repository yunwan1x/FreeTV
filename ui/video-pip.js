import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

export function setupPip(wall, status) {
  const enter = document.getElementById("pip");
  const back = document.getElementById("restorePip");
  const android = isTauri() ? invoke("native_radio") : Promise.resolve(false);
  let previous,
    changing = false;
  function compact(on, desktop = false) {
    document.body.classList.toggle("pip-mode", on);
    back.hidden = !on || !desktop;
  }
  async function restore() {
    if (!previous) return;
    const win = getCurrentWindow();
    const saved = previous;
    await win.setAlwaysOnTop(saved.onTop);
    await win.setMinSize(new LogicalSize(360, 540));
    await win.setSize(saved.size);
    await win.setPosition(saved.position);
    if (saved.maximized) await win.maximize();
    previous = null;
    compact(false);
  }
  back.onclick = () =>
    restore().catch((error) => status("恢复窗口失败 · " + error));
  window.addEventListener("freetv-pip-exit", () => compact(false));
  window.addEventListener("freetv-pip-enter", () => {
    compact(true);
    const video = wall.focused.video;
    if (video.paused) video.play().catch(() => {});
  });
  enter.onclick = async () => {
    const video = wall.focused.video;
    if (changing || !video.videoWidth) return;
    changing = true;
    try {
      if (await android) {
        compact(true);
        await invoke("plugin:radio|pip");
        return;
      }
      if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        try {
          await video.requestPictureInPicture();
          return;
        } catch (error) {
          if (!isTauri()) throw error;
        }
      }
      if (video.webkitSupportsPresentationMode?.("picture-in-picture")) {
        try {
          video.webkitSetPresentationMode("picture-in-picture");
          return;
        } catch (error) {
          if (!isTauri()) throw error;
        }
      }
      if (isTauri()) {
        const win = getCurrentWindow();
        previous = {
          size: await win.innerSize(),
          position: await win.outerPosition(),
          maximized: await win.isMaximized(),
          onTop: await win.isAlwaysOnTop(),
        };
        if (previous.maximized) await win.unmaximize();
        await win.setMinSize(new LogicalSize(240, 135));
        await win.setSize(new LogicalSize(420, 236));
        await win.setAlwaysOnTop(true);
        compact(true, true);
      } else {
        throw new Error("当前播放器未提供画中画");
      }
    } catch (error) {
      if (previous) await restore().catch(() => {});
      compact(false);
      status("无法打开画中画 · " + (error.message || error));
    } finally {
      changing = false;
    }
  };
}
