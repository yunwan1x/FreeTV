import { invoke, isTauri } from "@tauri-apps/api/core";
import { countryLabel, countryPicker } from "./country-picker.js";
import { setupRadio } from "./radio.js";
import { createWall } from "./video-wall.js";
import { setupFullscreen } from "./fullscreen.js";
import { setupPip } from "./video-pip.js";
import { previewFirstFrame } from "./player.js";
import checkerNotice from "../licenses/iptv-checker-rs.txt?raw";
import hlsNotice from "../node_modules/hls.js/LICENSE?raw";
import apacheLicense from "../node_modules/@tauri-apps/api/LICENSE-APACHE-2.0?raw";
import "./style.css";

const $ = (id) => document.getElementById(id);
const groupNames = ["央视", "卫视", "国际"];
const repositories = [
  { name: "Free-TV/IPTV", sources: [2] },
  { name: "best-fan/iptv-sources", sources: [0, 1] },
];
const feedNames = ["央视", "卫视", "全球"];
const allSources = [0, 1, 2];
function channelCountries(channel) {
  const tagged = (channel.region || "")
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((code) => /^[A-Z]{2}$/.test(code));
  const suffix = channel.epg_id
    ?.match(/\.([a-z]{2})(?:@[^.]*)?$/i)?.[1]
    .toUpperCase();
  const codes = tagged.length ? tagged : [suffix || "?"];
  return [...new Set(codes.map((code) => (code === "UK" ? "GB" : code)))];
}
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
const feedErrors = [];
const pendingSources = new Set();
let syncMessage = "";
let autoSync = read("auto-sync", true);
let country = "";
const tvPicker = countryPicker($("tvCountry"), (code) => {
  country = code;
  $("channels").scrollTo(0, 0);
  limit = 75;
  drawList();
});
let catalog = [],
  byId = new Map(),
  current,
  group = "央视",
  favoritesOnly = false,
  query = "",
  limit = 75;
let dialogType = "";
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
const wall = createWall({
  playRoutes: orderedRoutes,
  onFocus(tile) {
    current = tile.channel;
    $("now").textContent = current?.name || "从频道列表选择此画面的频道";
    $("save").disabled = $("routes").disabled = !current;
    drawFavorite();
    drawList();
    updateStatus(tile);
  },
  onStatus: updateStatus,
  onPlaying(channel, url) {
    preferred[channel.id] = url;
    write("preferred", preferred);
  },
  async onChoose() {
    await exitFullscreen();
    $("listTitle").scrollIntoView({ block: "nearest" });
    $("channels").querySelector("button")?.focus({ preventScroll: true });
  },
});
function updateStatus(tile) {
  const pause = $("videoToggle");
  pause.disabled = !tile.channel;
  pause.textContent = tile.url && !tile.video.paused ? "暂停" : "播放";
  status(tile.message);
  $("pip").disabled = !tile.url || tile.video.readyState < 2;
  renderRouteModal();
}
const radio = setupRadio(read, write, () => wall.stopAll());
function showPage(isRadio) {
  if (isRadio && !$("radioPage").hidden) return;
  const wasRadio = !$("radioPage").hidden;
  $("tvPage").hidden = isRadio;
  $("radioPage").hidden = !isRadio;
  $("search").parentElement.hidden = isRadio;
  $("radioNav").classList.toggle("active", isRadio);
  if (isRadio) {
    wall.stopAll();
    $("home").classList.remove("active");
    $("favorites").classList.remove("active");
    radio.open();
  } else if (wasRadio) {
    radio.close();
    drawList();
  }
  write("radio-visible", isRadio);
}
$("radioNav").onclick = () => showPage(true);
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
  if (current) wall.focused.player.play(orderedRoutes(current, first));
}

function rebuild() {
  const merged = new Map();
  for (const feed of feeds) {
    for (const c of feed?.channels ?? []) {
      const old = merged.get(c.id);
      if (old) {
        old.routes = [...new Set([...old.routes, ...c.routes])];
        old.epg_id ||= c.epg_id;
      } else
        merged.set(c.id, {
          ...c,
          group: c.group === "地方" ? "国际" : c.group,
          countries: channelCountries(c),
          routes: [...c.routes],
        });
    }
  }
  byId = merged;
  catalog = [...merged.values()];
  const counts = new Map();
  for (const c of catalog.filter((c) => c.group === "国际")) {
    for (const code of c.countries)
      counts.set(code, (counts.get(code) || 0) + 1);
  }
  if (!counts.has(country)) country = "";
  tvPicker.setOptions(
    Array.from(counts, ([code, count]) => ({ code, count })),
    country,
  );
  for (const tile of wall.tiles) {
    if (tile.channel && byId.has(tile.channel.id))
      tile.channel = byId.get(tile.channel.id);
  }
  current = wall.focused.channel;
  if (!wall.tiles.some((tile) => tile.channel)) {
    const selected = byId.get(read("lastChannel", "")) ?? catalog[0];
    if (selected) select(selected, false);
  }
  drawList();
  drawTabs();
}
async function refresh(sources = allSources) {
  if (pendingSources.size) return;
  syncMessage = "";
  for (const i of sources) {
    pendingSources.add(i);
    delete feedErrors[i];
  }
  renderSources();
  await Promise.all(
    sources.map(async (source) => {
      try {
        const result = await invoke("subscription", { source });
        feeds[source] = { channels: result.channels, updated: Date.now() };
        write("feed-" + source, feeds[source]);
      } catch (e) {
        feedErrors[source] = String(e);
      } finally {
        pendingSources.delete(source);
        renderSources();
      }
    }),
  );
  const failed = sources.filter((i) => feedErrors[i]).length;
  syncMessage = failed
    ? "同步结束，" + failed + " 份列表失败。"
    : "已同步 " + sources.length + " 份频道列表。";
  rebuild();
  if (!catalog.length) {
    status("请检查网络，打开「设置」重试。");
  }
  renderSources();
}
function drawTabs() {
  $("tabs").innerHTML =
    favoritesOnly || (query && group !== "国际")
      ? ""
      : groupNames
          .map((g) => action("group", g, group === g ? "active" : "", g))
          .join("");
}
function short(c) {
  return c.name.match(/^CCTV[- ]?\d+\+?/i)?.[0] || c.region || "TV";
}
function drawList() {
  const international = !favoritesOnly && group === "国际";
  $("countryFilter").hidden = !international;
  const items = catalog.filter(
    (c) =>
      (!favoritesOnly || favorites.has(c.id)) &&
      (!international ||
        (c.group === "国际" && (!country || c.countries.includes(country)))) &&
      (query
        ? [c.name, c.region, c.id, ...c.countries.map(countryLabel)]
            .join(" ")
            .toLowerCase()
            .includes(query)
        : favoritesOnly || group === c.group),
  );
  $("count").textContent = items.length + " 个频道";
  $("listTitle").textContent = favoritesOnly
    ? "我的收藏"
    : query
      ? "搜索结果"
      : "频道选择";
  $("favorites").classList.toggle(
    "active",
    favoritesOnly && $("radioPage").hidden,
  );
  $("home").classList.toggle("active", !favoritesOnly && $("radioPage").hidden);
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
            escape(c.countries.map(countryLabel).join("、")) +
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
        : pendingSources.size
          ? "正在更新频道…"
          : "暂无匹配频道") +
      "</p>";
  if (items.length > limit)
    $("channels").insertAdjacentHTML(
      "beforeend",
      action("more", "显示更多", "channel"),
    );
}
function select(c, start = true) {
  current = c;
  wall.focused.assign(c, start);
  group = c.group;
  if (country && group === "国际" && !c.countries.includes(country)) {
    country = "";
    tvPicker.setValue("");
  }
  write("lastChannel", c.id);
  $("now").textContent = c.name;
  $("save").disabled = $("routes").disabled = false;
  updateStatus(wall.focused);
  drawFavorite();
  drawTabs();
  drawList();
}
function drawFavorite() {
  if (!current) {
    $("save").textContent = "☆ 收藏";
    $("save").classList.remove("on");
    return;
  }
  $("save").textContent = favorites.has(current.id) ? "★ 已收藏" : "☆ 收藏";
  $("save").classList.toggle("on", favorites.has(current.id));
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
          (url === wall.focused.url ? "　· 当前" : "") +
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
  const syncButton = (repo) => {
    const busy = pendingSources.size ? " disabled" : "";
    return repo === undefined
      ? '<button class="outline" data-act="refresh"' +
          busy +
          ">同步全部上游</button>"
      : '<button class="outline" data-act="syncRepo" data-i="' +
          repo +
          '"' +
          busy +
          ">同步此仓库</button>";
  };
  const rows = repositories
    .map(({ name, sources }, repo) => {
      const details = sources
        .map((i) => {
          const feed = feeds[i];
          const saved = feed
            ? feed.channels.length +
              " 个频道 · 上次成功 " +
              new Date(feed.updated).toLocaleString("zh-CN")
            : "尚未载入";
          const error = feedErrors[i]
            ? '<small class="error">同步失败' +
              (feed ? "，已沿用上次列表" : "") +
              " · " +
              escape(feedErrors[i]) +
              "</small>"
            : "";
          return (
            '<div class="source-feed"><b>' +
            feedNames[i] +
            "</b><small>" +
            (pendingSources.has(i) ? "同步中…" : saved) +
            "</small>" +
            error +
            "</div>"
          );
        })
        .join("");
      return (
        '<section class="detail"><div class="between source-heading"><strong>' +
        name +
        "</strong>" +
        syncButton(repo) +
        "</div>" +
        details +
        "</section>"
      );
    })
    .join("");
  dialog(
    "sources",
    "<div class='between'><h2>频道源设置</h2>" +
      action("proxy", "网络代理", "outline") +
      "</div>" +
      '<label class="auto-sync"><input id="autoSync" type="checkbox"' +
      (autoSync ? " checked" : "") +
      ">启动时自动同步超过 6 小时的列表</label>" +
      rows +
      syncButton() +
      '<p role="status">' +
      (pendingSources.size ? "正在同步…" : syncMessage) +
      "</p>" +
      "<h3>线路检测</h3>" +
      scanControl(),
  );
}
async function openProxy() {
  dialog("proxy", $("proxyTemplate").innerHTML);
  const form = $("proxyForm");
  const message = form.querySelector("[role=status]");
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    const config = await invoke("proxy_settings");
    form.elements.mode.value = config.system ? "system" : "custom";
    const { address, username, password } = form.elements;
    address.value = config.address;
    username.value = config.username;
    const keepPassword = () =>
      config.hasPassword &&
      address.value.trim() === config.address &&
      username.value === config.username;
    function updateHint() {
      password.placeholder = keepPassword()
        ? "已保存，留空沿用"
        : "无需认证时留空";
    }
    function unpackAddress() {
      let url;
      try {
        url = new URL(address.value.trim());
      } catch {
        return;
      }
      if (!url.username && !url.password) return;
      const user = decodeURIComponent(url.username),
        pass = decodeURIComponent(url.password);
      url.username = url.password = "";
      address.value = url.href;
      username.value = user;
      password.value = pass;
    }
    address.onchange = () => {
      try {
        unpackAddress();
      } catch {
        message.textContent = "代理凭据编码无效";
      }
      updateHint();
    };
    address.oninput = username.oninput = updateHint;
    updateHint();
    const setMode = () => {
      const system = form.elements.mode.value === "system";
      address.disabled = username.disabled = password.disabled = system;
      form.querySelector("fieldset").disabled = system;
    };
    form.elements.mode.onchange = setMode;
    setMode();
    const flags = [...form.querySelectorAll("[type=checkbox]")];
    for (const flag of flags) flag.checked = config[flag.name];
    submit.disabled = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        unpackAddress();
      } catch {
        message.textContent = "代理凭据编码无效";
        submit.disabled = false;
        return;
      }
      const settings = {
        username: username.value,
        password: password.value,
        system: form.elements.mode.value === "system",
        address: form.elements.address.value.trim(),
      };
      for (const flag of flags) settings[flag.name] = flag.checked;
      try {
        const retain = keepPassword();
        await invoke("save_proxy", { settings, keepPassword: retain });
        config.hasPassword = !!password.value || retain;
        config.address = settings.address;
        config.username = settings.username;
        password.value = "";
        updateHint();
        if (form.isConnected) message.textContent = "代理设置已保存";
      } catch (error) {
        message.textContent = String(error);
      } finally {
        submit.disabled = false;
      }
    };
  } catch (error) {
    message.textContent = String(error);
  }
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
  showPage(false);
  favoritesOnly = false;
  query = "";
  $("search").value = "";
  group = current?.group ?? "央视";
  limit = 75;
  drawTabs();
  drawList();
};
$("favorites").onclick = () => {
  showPage(false);
  favoritesOnly = true;
  query = "";
  $("search").value = "";
  limit = 75;
  drawTabs();
  drawList();
};
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
$("dialogBody").addEventListener("change", (event) => {
  if (event.target.id === "autoSync") {
    autoSync = event.target.checked;
    write("auto-sync", autoSync);
  }
});
$("videoToggle").onclick = () => {
  const tile = wall.focused;
  if (!tile.channel) return;
  if (!tile.url) play();
  else if (tile.video.paused)
    tile.video.play().catch((error) => status(String(error)));
  else tile.video.pause();
};
$("layouts").onclick = (event) => {
  const button = event.target.closest("button[data-layout]");
  if (button) wall.layout(Number(button.dataset.layout));
};
setupPip(wall, status);
const exitFullscreen = setupFullscreen(status);
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
      query = $("search").value = "";
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
    case "proxy":
      openProxy();
      break;
    case "syncRepo":
      refresh(repositories[Number(i)].sources);
      break;
    case "refresh":
      refresh();
      break;
  }
});
wall.layout(1);
rebuild();
if (!isTauri()) {
  status("请从 FreeTV 客户端打开，或使用 npm run tauri dev 启动。");
} else {
  const stale = allSources.filter(
    (i) =>
      !feeds[i] ||
      (autoSync && Date.now() - feeds[i].updated > 6 * 3600 * 1000),
  );
  if (stale.length) refresh(stale);
}

if (read("radio-visible", false)) showPage(true);
