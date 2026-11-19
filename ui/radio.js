import { invoke } from "@tauri-apps/api/core";
import { countryPicker, radioCountries } from "./country-picker.js";
import { Player } from "./player.js";

const el = (id) => document.getElementById(id);
const stateLabels = {
  idle: "已停止",
  buffering: "正在连接…",
  playing: "正在收听",
  paused: "已暂停",
  error: "线路暂不可用",
  ended: "直播已结束",
};
const nativeCommand = (name, args = {}) => invoke("plugin:radio|" + name, args);
function validUrls(station) {
  return [...new Set([station.url_resolved, station.url])].filter((value) => {
    try {
      return ["https:", "http:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
}

export function setupRadio(read, write, stopTV) {
  const favorites = new Map(read("radio-favorites", []));
  const audio = el("radioAudio");
  let stations = [],
    selection = read("radio-station", null),
    state = "idle",
    lastError = "";
  let mode,
    favoritesOnly = false,
    visible = false,
    loading = false,
    next = null;
  let searchVersion = 0,
    playVersion = 0,
    syncTimer,
    syncing = false,
    restoring = false;
  let nativeWork = Promise.resolve();
  // Keep a stop requested during a native connection ahead of the next start.
  const enqueue = (task) =>
    (nativeWork = nativeWork.catch(() => {}).then(task));
  const backend = () =>
    (mode ??= invoke("native_radio").catch((error) => {
      mode = null;
      throw error;
    }));
  const desktop = new Player(
    audio,
    {
      trying: () => setState("buffering"),
      playing: () => setState("playing"),
      exhausted: () => setState("error"),
      tap: () => setState("paused"),
    },
    true,
  );
  function setState(value, error = "") {
    state = value;
    lastError = error;
    drawPlayer();
  }
  function meta(s) {
    return [s.countrycode, s.language, s.codec].filter(Boolean).join(" · ");
  }
  function drawPlayer() {
    el("radioName").textContent = selection?.name || "尚未选台";
    el("radioMeta").textContent = selection ? meta(selection) : "";
    el("radioStatus").textContent = selection
      ? lastError || stateLabels[state]
      : "选择电台开始收听";
    el("radioToggle").textContent =
      state === "playing" || state === "buffering" ? "暂停" : "播放";
    el("radioToggle").disabled = !selection || restoring;
    el("radioStop").disabled = state === "idle";
  }
  async function syncNative() {
    if (!visible || document.hidden || syncing) return;
    const version = playVersion;
    syncing = true;
    try {
      const result = await nativeCommand("status");
      if (version !== playVersion || !visible) return;
      if (result.id && result.id !== selection?.stationuuid) {
        selection =
          stations.find((s) => s.stationuuid === result.id) ||
          favorites.get(result.id) ||
          selection;
      }
      setState(result.state);
    } catch (error) {
      if (version === playVersion) setState("error", String(error));
    } finally {
      syncing = false;
    }
  }
  function watchNative() {
    clearInterval(syncTimer);
    syncTimer = setInterval(syncNative, 1500);
  }
  async function start(station) {
    if (!station) return;
    const version = ++playVersion;
    stopTV();
    selection = station;
    write("radio-station", station);
    setState("buffering");
    drawList();
    try {
      const urls = validUrls(station);
      if (!urls.length) throw Error("没有有效的播放地址");
      const native = await backend();
      if (version !== playVersion) return;
      const hls = !!station.hls || /\.m3u8([?#]|$)/i.test(urls[0]);
      if (native) {
        const local = await Promise.all(
          urls.map((url) =>
            invoke("playback_url", { url, radio: true, playlist: hls }),
          ),
        );
        if (version !== playVersion) return;
        await enqueue(() =>
          nativeCommand("start", {
            id: station.stationuuid,
            name: station.name,
            region: station.countrycode,
            url: local[0],
            fallback: local[1] || "",
            hls,
          }),
        );
        if (version === playVersion) {
          watchNative();
          await syncNative();
        }
      } else {
        desktop.play(urls, hls ? "hls" : "direct");
      }
    } catch (error) {
      if (version === playVersion) setState("error", String(error));
    }
  }
  async function control(action) {
    const version = ++playVersion;
    try {
      const native = await backend();
      if (version !== playVersion) return;
      if (native) {
        await enqueue(() => nativeCommand("control", { action }));
      } else if (action === "pause") {
        audio.pause();
      } else if (action === "resume") {
        await audio.play();
      } else {
        desktop.stop();
      }
      if (version === playVersion)
        setState(
          {
            pause: "paused",
            resume: native ? "buffering" : "playing",
            stop: "idle",
          }[action],
        );
      if (native && version === playVersion) await syncNative();
    } catch (error) {
      if (version === playVersion) setState("error", String(error));
    }
  }

  function drawList() {
    const list = el("radioList");
    list.replaceChildren();
    const items = favoritesOnly ? [...favorites.values()] : stations;
    for (const station of items) {
      const row = document.createElement("div");
      row.className = "radio-row";
      const tune = document.createElement("button");
      tune.className = "radio-station";
      const name = document.createElement("strong");
      name.textContent = station.name;
      const info = document.createElement("small");
      info.textContent = meta(station);
      tune.append(name, info);
      tune.onclick = () => start(station);
      if (selection?.stationuuid === station.stationuuid)
        tune.classList.add("selected");
      const star = document.createElement("button");
      star.className = "outline";
      const saved = favorites.has(station.stationuuid);
      star.setAttribute("aria-pressed", String(saved));
      star.setAttribute(
        "aria-label",
        (saved ? "取消收藏 " : "收藏 ") + station.name,
      );
      star.textContent = saved ? "★" : "☆";
      star.onclick = () => {
        if (saved) favorites.delete(station.stationuuid);
        else favorites.set(station.stationuuid, station);
        write("radio-favorites", [...favorites]);
        drawList();
      };
      row.append(tune, star);
      list.append(row);
    }
    el("radioMore").hidden = favoritesOnly || next === null;
    el("radioMore").disabled = loading;
    el("radioFavs").textContent = favoritesOnly ? "返回目录" : "电台收藏";
    el("radioFilters").hidden = favoritesOnly;
    if (favoritesOnly) {
      el("radioListTitle").textContent = "电台收藏";
      el("radioMessage").textContent = items.length
        ? ""
        : "点电台旁的星标即可收藏。";
    }
  }
  let filters = { name: "", country: "", language: "", tag: "" };
  async function search(offset = 0) {
    const version = ++searchVersion;
    loading = true;
    if (!offset) {
      stations = [];
      next = null;
    }
    el("radioListTitle").textContent = Object.values(filters).some(Boolean)
      ? "搜索结果"
      : "热门电台";
    el("radioMessage").textContent = "正在加载…";
    drawList();
    try {
      const page = await invoke("radio_stations", { ...filters, offset });
      if (version !== searchVersion) return;
      const merged = new Map(
        [...stations, ...page.stations].map((s) => [s.stationuuid, s]),
      );
      stations = [...merged.values()];
      next = page.next;
      el("radioMessage").textContent = stations.length ? "" : "没有匹配的电台";
    } catch (error) {
      if (version === searchVersion)
        el("radioMessage").textContent = String(error);
    } finally {
      if (version === searchVersion) {
        loading = false;
        drawList();
      }
    }
  }
  const picker = countryPicker(el("radioCountry"), () =>
    el("radioFilters").requestSubmit(),
  );
  picker.setOptions(radioCountries);
  el("radioFilters").onsubmit = (e) => {
    e.preventDefault();
    filters = Object.fromEntries(new FormData(e.target));
    filters.country = picker.value;
    search();
  };
  el("radioFavs").onclick = () => {
    favoritesOnly = !favoritesOnly;
    if (!favoritesOnly) {
      if (!stations.length) {
        search();
        return;
      }
      el("radioMessage").textContent = "";
      el("radioListTitle").textContent = Object.values(filters).some(Boolean)
        ? "搜索结果"
        : "热门电台";
    }
    drawList();
  };
  el("radioMore").onclick = () => {
    if (next !== null && !loading) search(next);
  };
  el("radioToggle").onclick = () => {
    if (state === "playing" || state === "buffering") control("pause");
    else if (state === "paused") control("resume");
    else start(selection);
  };
  el("radioStop").onclick = () => control("stop");
  document.addEventListener("visibilitychange", () => {
    if (visible && !document.hidden && syncTimer) syncNative();
  });

  return {
    async open() {
      visible = true;
      drawPlayer();
      drawList();
      if (!stations.length && !loading && !favoritesOnly) search();
      if (selection) {
        const version = playVersion;
        restoring = true;
        drawPlayer();
        try {
          if ((await backend()) && visible && version === playVersion) {
            watchNative();
            await syncNative();
          }
        } catch (error) {
          setState("error", String(error));
        } finally {
          restoring = false;
          drawPlayer();
        }
      }
    },
    close() {
      visible = false;
      clearInterval(syncTimer);
      syncTimer = null;
      if (state !== "idle" || restoring) control("stop");
    },
  };
}
