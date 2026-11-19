import { invoke, isTauri } from "@tauri-apps/api/core";
import { Player, previewFirstFrame } from "./player.js";
import checkerNotice from "../licenses/iptv-checker-rs.txt?raw";
import hlsNotice from "../node_modules/hls.js/LICENSE?raw";
import apacheLicense from "../node_modules/@tauri-apps/api/LICENSE-APACHE-2.0?raw";
import "./style.css";

const $ = (id) => document.getElementById(id);
const groupNames = ["央视", "卫视", "地方", "国际"];
const feedNames = ["best-fan · 央视", "best-fan · 卫视", "Free-TV · 全球"];
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be full. Live playback still works. */
  }
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const action = (name, text, cls = "", i = "") =>
  '<button class="' +
  cls +
  '" data-act="' +
  name +
  '" data-i="' +
  escape(i) +
  '">' +
  text +
  "</button>";
let feeds = feedNames.map((_, i) => read("feed-" + i, null));
let feedErrors = [],
  refreshing = false;
let catalog = [],
  byId = new Map(),
  current,
  group = "央视",
  favoritesOnly = false,
  query = "",
  limit = 75;
let activeUrl = "",
  shows = [],
  guideMessage = "",
  guideVersion = 0,
  dialogType = "",
  visibleShows = [];
let scanVersion = 0,
  scanning = false,
  scanDone = 0,
  scanTotal = 0,
  scanLabel = "";
const favorites = new Set(read("favorites", [])),
  preferred = read("preferred", {}),
  health = new Map(read("health", []));
const inFlight = new Map();
function status(text) {
  $("status").textContent = text;
}
const player = new Player($("video"), {
  trying(url) {
    activeUrl = url;
    $("cover").hidden = true;
    status("正在连接线路 " + (current.routes.indexOf(url) + 1) + "…");
    renderRouteModal();
  },
  playing(url) {
    preferred[current.id] = url;
    write("preferred", preferred);
    status("已实际起播 · 线路 " + (current.routes.indexOf(url) + 1));
    renderRouteModal();
  },
  exhausted() {
    activeUrl = "";
    $("cover").hidden = false;
    $("play").textContent = "重新播放";
    status("当前频道的线路均未能起播，可检测线路或稍后重试。");
    renderRouteModal();
  },
  tap() {
    status("请点画面中的播放键继续");
  },
});

function orderedRoutes(channel, first) {
  const weight = (url) =>
    health.get(url)?.ms ?? (health.has(url) ? Infinity : 1e6);
  return [
    ...new Set([
      first ?? preferred[channel.id],
      ...[...channel.routes].sort((a, b) => weight(a) - weight(b)),
    ]),
  ].filter((url) => channel.routes.includes(url));
}
function play(first) {
  if (current) player.play(orderedRoutes(current, first));
}

function rebuild() {
  const merged = new Map();
  for (const feed of feeds) {
    for (const c of feed?.channels ?? []) {
      const old = merged.get(c.id);
      if (old) {
        old.routes = [...new Set([...old.routes, ...c.routes])];
        old.epg_id ||= c.epg_id;
      } else merged.set(c.id, { ...c, routes: [...c.routes] });
    }
  }
  byId = merged;
  catalog = [...merged.values()];
  if (current && byId.has(current.id)) current = byId.get(current.id);
  else {
    const selected = byId.get(read("lastChannel", "")) ?? catalog[0];
    if (selected) select(selected, false);
  }
  drawList();
  drawQuick();
  drawTabs();
}
async function refresh(fullCheck = false) {
  if (refreshing) return;
  refreshing = true;
  feedErrors = [];
  renderSources();
  try {
    await Promise.all(
      feedNames.map(async (_, source) => {
        try {
          const result = await invoke("subscription", { source });
          feeds[source] = { channels: result.channels, updated: Date.now() };
          write("feed-" + source, feeds[source]);
        } catch (e) {
          feedErrors[source] = String(e);
        }
      }),
    );
    rebuild();
    if (!current) {
      $("title").textContent = "暂时无法载入频道";
      status("请检查网络，打开「频道订阅」重试。");
    }
  } finally {
    refreshing = false;
    renderSources();
  }
  if (fullCheck && catalog.length)
    scan(
      catalog.flatMap((c) => c.routes),
      "全部订阅",
    );
}
function drawTabs() {
  $("tabs").innerHTML =
    favoritesOnly || query
      ? ""
      : groupNames
          .map((g) => action("group", g, group === g ? "active" : "", g))
          .join("");
}
function short(c) {
  return c.name.match(/^CCTV[- ]?\d+\+?/i)?.[0] || c.region || "TV";
}
function drawList() {
  const items = catalog.filter(
    (c) =>
      (!favoritesOnly || favorites.has(c.id)) &&
      (query
        ? (c.name + " " + c.region + " " + c.id).toLowerCase().includes(query)
        : favoritesOnly || group === c.group),
  );
  $("count").textContent = items.length + " 个频道";
  $("listTitle").textContent = favoritesOnly
    ? "我的收藏"
    : query
      ? "搜索结果"
      : "频道选择";
  $("favorites").classList.toggle("active", favoritesOnly);
  $("home").classList.toggle("active", !favoritesOnly);
  $("channels").innerHTML =
    items
      .slice(0, limit)
      .map((c) =>
        action(
          "channel",
          '<span class="call">' +
            escape(short(c)) +
            "</span><span><b>" +
            escape(c.name) +
            "</b><small>" +
            escape(c.region) +
            " · " +
            c.routes.length +
            " 条线路</small></span>",
          "channel " + (c.id === current?.id ? "active" : ""),
          c.id,
        ),
      )
      .join("") ||
    '<p class="empty">' +
      (favoritesOnly
        ? "暂无收藏频道"
        : refreshing
          ? "正在更新频道…"
          : "暂无匹配频道") +
      "</p>";
  if (items.length > limit)
    $("channels").insertAdjacentHTML(
      "beforeend",
      action("more", "显示更多", "channel"),
    );
}
function drawQuick() {
  const picks = groupNames
    .map((g) => catalog.find((c) => c.group === g && c.id !== current?.id))
    .filter(Boolean);
  $("quick").innerHTML = picks
    .map((c) =>
      action(
        "channel",
        "<small>" +
          escape(c.group) +
          "</small><strong>" +
          escape(c.name) +
          "</strong>",
        "card",
        c.id,
      ),
    )
    .join("");
}
function select(c, start = true) {
  player.stop();
  current = c;
  activeUrl = "";
  group = c.group;
  write("lastChannel", c.id);
  $("cover").hidden = false;
  $("title").textContent = $("now").textContent = c.name;
  $("station").textContent = c.group + " · " + (c.region || "TV");
  $("play").disabled = $("save").disabled = $("routes").disabled = false;
  $("play").textContent = "▶ 播放直播";
  $("guideName").textContent = c.name;
  status("");
  drawFavorite();
  drawTabs();
  drawList();
  drawQuick();
  loadGuide(c);
  if (start) play();
}
function drawFavorite() {
  $("save").textContent = favorites.has(current.id) ? "★ 已收藏" : "☆ 收藏";
  $("save").classList.toggle("on", favorites.has(current.id));
}
async function loadGuide(c) {
  const version = ++guideVersion;
  shows = [];
  guideMessage = "正在获取节目单…";
  drawGuide();
  try {
    const result = await invoke("programmes", {
      region: c.region,
      name: c.name,
      id: c.epg_id,
    });
    if (version !== guideVersion) return;
    shows = result;
    guideMessage = "该频道暂无节目预告";
  } catch {
    if (version !== guideVersion) return;
    guideMessage = "节目单暂不可用";
  }
  drawGuide();
}
function clock(t) {
  return new Date(t * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function drawGuide() {
  const now = Date.now() / 1000;
  visibleShows = shows.filter((s) => s.stop > now).slice(0, 4);
  $("shows").innerHTML =
    visibleShows
      .map((s, i) =>
        action(
          "show",
          "<time>" +
            clock(s.start) +
            "</time><small>" +
            (s.start <= now ? "正在播出" : "即将播出") +
            "</small><b>" +
            escape(s.title) +
            "</b>",
          "slot " + (s.start <= now ? "live" : ""),
          i,
        ),
      )
      .join("") ||
    '<p class="empty">' +
      escape(guideMessage || "选择频道后查看节目单") +
      "</p>";
}
function dialog(type, html) {
  dialogType = type;
  $("dialogBody").innerHTML = html;
  if (!$("dialog").open) $("dialog").showModal();
}
let deepBackend,
  testingUrl,
  previewController,
  pickerMessage = "";
let ffmpegPath = read("ffmpeg-path", null);
const deepResults = new Map();
async function checkFirstFrame(url) {
  if (testingUrl || !url || !deepBackend) return;
  testingUrl = url;
  deepResults.delete(url);
  renderRouteModal();
  const start = performance.now();
  try {
    if (deepBackend === "player") {
      previewController = new AbortController();
      await previewFirstFrame(url, $("dialog"), previewController.signal);
    } else {
      await invoke("decode_route", { url, path: ffmpegPath });
    }
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    deepResults.set(url, "已解码首帧 · " + elapsed + " 秒");
  } catch (error) {
    deepResults.set(
      url,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    testingUrl = null;
    previewController = null;
    renderRouteModal();
  }
}

async function chooseFFmpeg() {
  pickerMessage = "";
  try {
    const path = await invoke("choose_ffmpeg");
    if (path) {
      ffmpegPath = path;
      write("ffmpeg-path", path);
    }
  } catch (error) {
    pickerMessage = String(error);
  }
  renderRouteModal();
}
function deepSettings() {
  if (deepBackend === "player")
    return "<small>深度检测将静音试播所选线路，最多 15 秒。</small>";
  if (deepBackend !== "ffmpeg") return "";
  return (
    '<div class="probe-settings"><small>FFmpeg · ' +
    escape(ffmpegPath || "自动查找") +
    "</small>" +
    action("chooseFFmpeg", "选择程序", "textbtn") +
    (ffmpegPath ? action("autoFFmpeg", "恢复自动查找", "textbtn") : "") +
    (pickerMessage ? "<small>" + escape(pickerMessage) + "</small>" : "") +
    "</div>"
  );
}
function renderRouteModal() {
  if (dialogType !== "routes" || !current) return;
  const rows = current.routes
    .map((url, i) => {
      const result = health.get(url);
      const routeButton = action(
        "route",
        "线路 " +
          (i + 1) +
          (url === activeUrl ? "　· 当前" : "") +
          "<small>" +
          escape(new URL(url).host) +
          "　" +
          escape(
            result
              ? result.detail +
                  (result.ms != null ? " · " + result.ms + " ms" : "")
              : "待检测",
          ) +
          "</small>",
        "detail",
        i,
      );
      const message =
        testingUrl === url ? "正在验证首帧…" : deepResults.get(url);
      const deepButton = deepBackend
        ? '<button class="outline" data-act="deep" data-i="' +
          i +
          '"' +
          (testingUrl ? " disabled" : "") +
          ">深度检测</button>"
        : "";
      return (
        '<div class="probe-row">' +
        routeButton +
        deepButton +
        (message
          ? '<small role="status">' + escape(message) + "</small>"
          : "") +
        "</div>"
      );
    })
    .join("");
  dialog(
    "routes",
    "<h2>" +
      escape(current.name) +
      " · 线路</h2>" +
      scanControl() +
      deepSettings() +
      rows,
  );
}
function scanControl() {
  return (
    '<div class="health">' +
    (scanning
      ? action("cancel", "停止检测", "outline") +
        " <small>" +
        escape(scanLabel) +
        "　" +
        scanDone +
        " / " +
        scanTotal +
        "</small>"
      : action(
          dialogType === "routes" ? "checkChannel" : "checkAll",
          dialogType === "routes" ? "检测当前频道" : "检测全部线路",
          "outline",
        )) +
    "</div>"
  );
}
function renderSources() {
  if (dialogType !== "sources") return;
  const rows = feedNames
    .map(
      (name, i) =>
        '<div class="detail"><b>' +
        name +
        "</b><small>" +
        (feeds[i]
          ? feeds[i].channels.length +
            " 个频道 · " +
            new Date(feeds[i].updated).toLocaleString("zh-CN")
          : "尚未载入") +
        "</small>" +
        (feedErrors[i]
          ? '<small class="error">更新失败 · ' +
            escape(feedErrors[i]) +
            "</small>"
          : "") +
        "</div>",
    )
    .join("");
  dialog(
    "sources",
    "<h2>频道订阅</h2>" +
      rows +
      (refreshing
        ? "<p>正在更新…</p>"
        : action("refresh", "更新订阅并检测", "outline")) +
      scanControl(),
  );
}
async function measure(url) {
  if (inFlight.has(url)) return inFlight.get(url);
  const request = invoke("probe_route", { url })
    .then((result) => health.set(url, result))
    .catch((error) => health.set(url, { url, ms: null, detail: String(error) }))
    .finally(() => inFlight.delete(url));
  inFlight.set(url, request);
  return request;
}
async function scan(urls, label) {
  const version = ++scanVersion,
    pending = [...new Set(urls)];
  let next = 0;
  scanTotal = pending.length;
  scanDone = 0;
  scanLabel = label;
  scanning = true;
  const redraw = () => {
    renderSources();
    renderRouteModal();
  };
  redraw();
  async function worker() {
    while (version === scanVersion && next < pending.length) {
      const url = pending[next++];
      await measure(url);
      if (version !== scanVersion) return;
      scanDone++;
      if (scanDone % 6 === 0 || pending.length < 8) redraw();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(6, pending.length) }, worker),
  );
  if (version === scanVersion) {
    scanning = false;
    write("health", [...health]);
    redraw();
  }
}
$("notices").onclick = () =>
  dialog(
    "licenses",
    "<h2>开源许可</h2>" +
      [
        ["iptv-checker-rs", checkerNotice],
        ["hls.js", hlsNotice],
        ["Apache License 2.0", apacheLicense],
      ]
        .map(
          ([name, text]) =>
            "<details><summary>" +
            name +
            "</summary><pre>" +
            escape(text) +
            "</pre></details>",
        )
        .join(""),
  );
$("dialog").onclose = () => {
  previewController?.abort();
  dialogType = "";
};
$("close").onclick = () => $("dialog").close();
$("manage").onclick = () => {
  dialogType = "sources";
  renderSources();
};
$("routes").onclick = () => {
  dialogType = "routes";
  renderRouteModal();
  if (!deepBackend)
    invoke("deep_check_backend")
      .then((mode) => {
        deepBackend = mode;
        renderRouteModal();
      })
      .catch((error) => status(String(error)));
};
$("home").onclick = () => {
  favoritesOnly = false;
  query = "";
  $("search").value = "";
  group = current?.group ?? "央视";
  limit = 75;
  drawTabs();
  drawList();
};
$("favorites").onclick = () => {
  favoritesOnly = true;
  query = "";
  $("search").value = "";
  limit = 75;
  drawTabs();
  drawList();
};
$("schedule").onclick = () => $("guide").scrollIntoView({ block: "center" });
$("save").onclick = () => {
  if (!current) return;
  if (favorites.has(current.id)) favorites.delete(current.id);
  else favorites.add(current.id);
  write("favorites", [...favorites]);
  drawFavorite();
  drawList();
};
$("search").oninput = (e) => {
  query = e.target.value.trim().toLowerCase();
  favoritesOnly = false;
  limit = 75;
  drawTabs();
  drawList();
};
$("play").onclick = () => play();
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const i = b.dataset.i;
  switch (b.dataset.act) {
    case "channel":
      if (byId.has(i)) select(byId.get(i));
      break;
    case "group":
      group = i;
      limit = 75;
      drawTabs();
      drawList();
      break;
    case "more":
      limit += 75;
      drawList();
      break;
    case "route":
      $("dialog").close();
      play(current.routes[Number(i)]);
      break;
    case "deep":
      checkFirstFrame(current.routes[Number(i)]);
      break;
    case "chooseFFmpeg":
      chooseFFmpeg();
      break;
    case "autoFFmpeg":
      ffmpegPath = null;
      write("ffmpeg-path", null);
      pickerMessage = "";
      renderRouteModal();
      break;
    case "checkChannel":
      scan(current.routes, current.name);
      break;
    case "checkAll":
      scan(
        catalog.flatMap((c) => c.routes),
        "全部订阅",
      );
      break;
    case "cancel":
      scanVersion++;
      scanning = false;
      write("health", [...health]);
      renderSources();
      renderRouteModal();
      break;
    case "refresh":
      refresh(true);
      break;
    case "show": {
      const s = visibleShows[Number(i)];
      dialog(
        "show",
        "<h2>" +
          escape(s.title) +
          "</h2><p>" +
          escape(current.name) +
          " · " +
          new Date(s.start * 1000).toLocaleDateString("zh-CN") +
          " " +
          clock(s.start) +
          " — " +
          clock(s.stop) +
          "</p>",
      );
      break;
    }
  }
});
rebuild();
drawGuide();
setInterval(drawGuide, 60000);
if (!isTauri()) {
  status("请从 FreeTV 客户端打开，或使用 npm run tauri dev 启动。");
} else if (
  feeds.some((feed) => !feed || Date.now() - feed.updated > 6 * 3600 * 1000)
)
  refresh();
