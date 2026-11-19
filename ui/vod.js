import { invoke } from "@tauri-apps/api/core";
import { Player } from "./player.js";
import { setupVodSettings, mediathek } from "./vod-settings.js";
import "./vod.css";

const $ = (id) => document.getElementById(id);
const element = (type, text, cls) => {
  const el = document.createElement(type);
  if (text) el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
const identity = (f) => JSON.stringify([f.source, f.id]);
const meta = (f) => [f.year, f.category, f.note].filter(Boolean).join(" · ");
const episodeNumber = (name) =>
  name?.trim().match(/^(?:第\s*)?0*(\d+)(?:\s*[集期话])?$/)?.[1];
function matchingEpisode(episodes, label) {
  const ordinal = episodeNumber(label);
  return episodes.findIndex(
    (e) =>
      e.name === label ||
      (ordinal !== undefined && episodeNumber(e.name) === ordinal),
  );
}
function snapshot(f) {
  const { lines, ...card } = f;
  return card;
}

// Fetch only visible covers through the catalog route, including in custom proxy mode.
function posterLoader() {
  let version = 0,
    queue = [],
    active = 0;
  const cache = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries)
        if (isIntersecting) {
          observer.unobserve(target);
          queue.push([target, version]);
        }
      drain();
    },
    { rootMargin: "80px" },
  );
  async function fetchPoster(target, stamp) {
    const url = target.dataset.src;
    try {
      let data = cache.get(url);
      if (!data) {
        const raw = await invoke("vod_poster", { url });
        const arr = new Uint8Array(raw);
        // Only embed raster covers; SVG documents are unnecessary for movie artwork.
        const isImage =
          (arr[0] === 0xff && arr[1] === 0xd8) ||
          (arr[0] === 0x89 && arr[1] === 0x50) ||
          (arr[0] === 0x47 && arr[1] === 0x49) ||
          (arr[0] === 0x52 && arr[1] === 0x49);
        if (!isImage || stamp !== version) return;
        data = URL.createObjectURL(new Blob([arr]));
        if (cache.size >= 80) {
          const key = cache.keys().next().value;
          URL.revokeObjectURL(cache.get(key));
          cache.delete(key);
        }
        cache.set(url, data);
      }
      if (stamp === version && target.isConnected) {
        target.onload = () => target.classList.add("loaded");
        target.src = data;
      }
    } catch {
      /* The title remains visible when a station has no cover. */
    }
  }
  function drain() {
    while (active < 3 && queue.length) {
      const [img, stamp] = queue.shift();
      if (!img.isConnected || stamp !== version) continue;
      active++;
      fetchPoster(img, stamp).finally(() => {
        active--;
        drain();
      });
    }
  }
  return {
    observe(img) {
      observer.observe(img);
    },
    reset() {
      version++;
      observer.disconnect();
      queue = [];
    },
  };
}
export function setupVod(read, write) {
  let visible = false,
    view = "browse",
    previous = "browse",
    filter = "",
    query = "",
    savedOnly = false;
  let catalogEpoch = 0,
    detailEpoch = 0,
    busy = false,
    results = new Map(),
    catalogKey = "";
  let film = null,
    source = null,
    lines = [],
    line = 0,
    episode = -1,
    seeking = 0,
    lastWrite = 0,
    playSucceeded = false,
    alternatives = [];
  let history = read("vod-resume", null);
  const bookmarks = new Map(read("vod-favorites", []));
  const covers = posterLoader(),
    video = $("vodVideo");
  const settings = setupVodSettings(read, write, () => {
    if (visible && view === "browse" && catalogKey !== key()) load();
  });
  const enabled = () => settings.sources().filter((s) => s.enabled);
  const key = () => JSON.stringify(enabled().map((s) => [s.id, s.api]));
  const message = (t) => ($("vodPlayback").textContent = t);
  const player = new Player(
    video,
    {
      trying() {
        message("正在加载…");
      },
      tap() {
        message("请点播放器开始播放");
      },
      playing() {
        message(
          "正在播放 · " +
            source.name +
            " · " +
            lines[line].episodes[episode].name,
        );
        if (!playSucceeded) {
          settings.record(source.id, "play", "试播成功");
          playSucceeded = true;
        }
        persist();
      },
      exhausted() {
        message("此线路未能播放，请重试或更换影片来源。");
        if (source) settings.record(source.id, "play", "试播失败");
      },
      ended() {
        message("本集已播完");
        if (history && identity(history.film) === identity(film)) {
          history = null;
          write("vod-resume", null);
        }
      },
    },
    false,
    true,
  );
  function persist() {
    if (
      !film ||
      !playSucceeded ||
      seeking > 0 ||
      !Number.isFinite(video.currentTime) ||
      video.ended ||
      video.currentTime <= 0 ||
      episode < 0
    )
      return;
    history = {
      film: snapshot(film),
      name: lines[line].episodes[episode].name,
      lineName: lines[line].name,
      position: video.currentTime,
    };
    write("vod-resume", history);
    lastWrite = Date.now();
  }
  video.ontimeupdate = () => {
    if (Date.now() - lastWrite > 5000) persist();
  };
  video.onpause = persist;
  video.onloadedmetadata =
    video.ondurationchange =
    video.oncanplay =
      () => {
        if (
          seeking > 0 &&
          video.readyState >= 1 &&
          Number.isFinite(video.duration) &&
          video.duration > 0
        ) {
          video.currentTime = Math.min(
            seeking,
            Math.max(0, video.duration - 1),
          );
          seeking = 0;
        }
      };
  window.addEventListener("pagehide", persist);
  function stop() {
    persist();
    playSucceeded = false;
    seeking = 0;
    player.stop();
  }
  function selectView(next) {
    if (view === "watch" && next !== "watch") {
      stop();
      detailEpoch++;
    }
    covers.reset();
    settings.close();
    view = next;
    for (const [name, id] of [
      ["browse", "vodBrowse"],
      ["watch", "vodWatch"],
      ["settings", "vodSettings"],
    ])
      $(id).hidden = name !== view;
    window.scrollTo(0, 0);
  }
  function drawFilters() {
    const entries = enabled();
    if (filter && !entries.some((s) => s.id === filter)) filter = "";
    $("vodFilters").replaceChildren(
      ...[{ id: "", name: "全部来源" }, ...entries].map((s) => {
        const b = element("button", s.name, "outline");
        b.setAttribute("aria-pressed", String(filter === s.id));
        b.onclick = () => {
          filter = s.id;
          savedOnly = false;
          load();
        };
        return b;
      }),
    );
  }
  function drawCards() {
    if (view !== "browse" || !visible) return;
    covers.reset();
    drawFilters();
    $("vodListTitle").textContent = savedOnly
      ? "我的片单"
      : query
        ? "搜索结果"
        : "最近更新";
    $("vodBookmarks").setAttribute("aria-pressed", String(savedOnly));
    const resume = $("vodResume");
    resume.hidden =
      !history ||
      savedOnly ||
      !!query ||
      !enabled().some((s) => s.id === history.film.source);
    if (!resume.hidden)
      resume.replaceChildren(
        element("small", "继续观看"),
        element("strong", history.film.title),
        element(
          "span",
          history.name +
            " · 已看 " +
            Math.floor(history.position / 60) +
            " 分钟　 ▶",
        ),
      );
    // Interleave source pages so the first screen includes each selected provider.
    let films = [];
    if (savedOnly) films = [...bookmarks.values()];
    else {
      const pages = [...results.values()].map((x) => x.films);
      for (let i = 0; i < Math.max(0, ...pages.map((p) => p.length)); i++)
        for (const page of pages) if (page[i]) films.push(page[i]);
    }
    const byId = new Map(films.map((f) => [identity(f), f]));
    const known = settings.sources();
    $("vodCards").replaceChildren(
      ...[...byId.values()].map((f) => {
        const provider = known.find((s) => s.id === f.source);
        const card = element("button", null, "vod-card");
        const cover = element("div", null, "vod-cover");
        cover.append(
          element("span", f.title.slice(0, 10), "vod-cover-fallback"),
        );
        if (f.poster) {
          const img = element("img");
          img.alt = "";
          img.dataset.src = f.poster;
          cover.append(img);
          covers.observe(img);
        }
        if (f.note) cover.append(element("small", f.note, "vod-badge"));
        card.append(
          cover,
          element("b", f.title),
          element(
            "small",
            [provider?.name || "已移除的来源", f.year || f.category]
              .filter(Boolean)
              .join(" · "),
          ),
        );
        card.onclick = () => watch(f);
        return card;
      }),
    );
    const failures = [...results.values()]
      .filter((p) => p.error)
      .map((p) => p.name + "：" + p.error);
    const status = savedOnly
      ? films.length
        ? ""
        : "片单为空，在播放页可收藏影片。"
      : busy
        ? "正在读取片库…"
        : !enabled().length
          ? "请在点播设置中启用来源。"
          : failures.length
            ? failures.join("；")
            : films.length
              ? ""
              : "未找到匹配的影片。";
    $("vodMessage").textContent = status;
    $("vodMore").hidden =
      savedOnly || ![...results.values()].some((p) => p.more);
    $("vodMore").disabled = busy;
  }
  async function load(more = false) {
    const stamp = ++catalogEpoch;
    catalogKey = key();
    if (!more) results = new Map();
    drawFilters();
    if (savedOnly) {
      busy = false;
      drawCards();
      return;
    }
    const sources = enabled().filter((s) => !filter || s.id === filter);
    busy = true;
    for (const s of sources)
      if (!results.has(s.id))
        results.set(s.id, { films: [], page: 0, more: true, name: s.name });
    drawCards();
    async function fetchPage(s) {
      const entry = results.get(s.id);
      if (more && !entry.more) return;
      try {
        const page = await invoke("vod_catalog", {
          api: s.api,
          query,
          page: entry.page + 1,
        });
        if (stamp !== catalogEpoch) return;
        entry.films.push(...page.films.map((f) => ({ ...f, source: s.id })));
        entry.page++;
        entry.more = page.more;
        entry.error = "";
        settings.record(s.id, "catalog", "目录可读");
      } catch (e) {
        if (stamp !== catalogEpoch) return;
        entry.error = String(e);
        entry.more = false;
        settings.record(s.id, "catalog", "目录读取失败");
      }
      drawCards();
    }
    let index = 0;
    async function worker() {
      while (stamp === catalogEpoch && index < sources.length)
        await fetchPage(sources[index++]);
    }
    await Promise.all(
      Array.from({ length: Math.min(4, sources.length) }, worker),
    );
    if (stamp === catalogEpoch) {
      busy = false;
      drawCards();
    }
  }
  function browse() {
    selectView("browse");
    if (catalogKey !== key() || (!results.size && !savedOnly)) load();
    else drawCards();
  }
  function setBookmark() {
    const k = identity(film);
    if (bookmarks.has(k)) bookmarks.delete(k);
    else
      bookmarks.set(
        k,
        film.lines?.length && source?.api === mediathek ? film : snapshot(film),
      );
    write("vod-favorites", [...bookmarks]);
    updateBookmark();
  }
  function updateBookmark() {
    $("vodSave").textContent = bookmarks.has(identity(film))
      ? "已收藏"
      : "＋ 收藏";
  }
  function clearControls() {
    $("vodEpisodes").inert = false;
    $("vodLine").disabled = false;
    $("vodLine").replaceChildren();
    $("vodEpisodes").replaceChildren();
    $("vodEpCount").textContent = "";
    $("vodRetry").disabled = true;
  }
  function setProviders() {
    const select = $("vodProvider");
    select.replaceChildren(
      ...alternatives.map((s) => new Option(s.name, s.id)),
    );
    select.value = source?.id || "";
    select.disabled = alternatives.length < 2;
  }
  function drawEpisodes() {
    const episodes = lines[line]?.episodes || [];
    $("vodEpCount").textContent = episodes.length + " 集";
    $("vodEpisodes").replaceChildren(
      ...episodes.map((ep, i) => {
        const b = element("button", ep.name, "outline");
        b.setAttribute("aria-pressed", String(i === episode));
        b.onclick = () => start(i);
        return b;
      }),
    );
    $("vodRetry").disabled = episode < 0;
  }
  function start(i, pos = 0) {
    stop();
    episode = i;
    seeking = pos;
    drawEpisodes();
    const url = lines[line].episodes[i].url;
    player.play(
      [url],
      /\.m3u8(?:[?#]|$)/i.test(url)
        ? "hls"
        : /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url)
          ? "direct"
          : "auto",
    );
  }
  function applyLines(f, match, pos = 0, lineName = "") {
    film = { ...f, source: source.id };
    lines = film.lines;
    line = Math.max(
      0,
      lines.findIndex((v) => v.name === lineName),
    );
    episode = -1;
    $("vodTitle").textContent = film.title;
    updateBookmark();
    $("vodLine").replaceChildren(
      ...lines.map((l, i) => new Option(l.name, String(i))),
    );
    $("vodLine").value = String(line);
    if (!lines.length) {
      clearControls();
      message("该来源未提供可播放的分集，请更换来源。");
      return;
    }
    const idx = match ? matchingEpisode(lines[line].episodes, match) : 0;
    if (idx >= 0) start(idx, pos);
    else {
      drawEpisodes();
      message("该线路的集名不同，请选择对应分集。");
    }
  }
  async function watch(item, resume = null) {
    stop();
    const token = ++detailEpoch;
    selectView("watch");
    film = item;
    source = enabled().find((s) => s.id === item.source);
    lines = [];
    line = 0;
    episode = -1;
    clearControls();
    $("vodTitle").textContent = item.title;
    updateBookmark();
    alternatives = source
      ? [
          source,
          ...enabled().filter(
            (s) =>
              s.id !== source.id &&
              s.api !== mediathek &&
              source.api !== mediathek,
          ),
        ]
      : [];
    setProviders();
    if (!source) {
      message("此来源已停用或移除，可在点播设置中重新启用。");
      return;
    }
    message("正在读取分集…");
    try {
      let data;
      if (source.api === mediathek) {
        data = item;
        if (!data.lines?.length) {
          const refreshed = await invoke("vod_catalog", {
            api: source.api,
            query: item.title,
            page: 1,
          });
          data =
            refreshed.films.find(
              (v) => v.id === item.id || v.title === item.title,
            ) || item;
        }
      } else
        data = await invoke("vod_detail", { api: source.api, id: item.id });
      if (token !== detailEpoch) return;
      // MediathekView returns recording URLs with its search results.
      if (!data.lines?.length && source.api === mediathek) {
        message("节目链接已过期，请重新搜索节目。");
        return;
      }
      applyLines(data, resume?.name, resume?.position, resume?.lineName);
    } catch (e) {
      if (token === detailEpoch) message("读取分集失败：" + e);
    }
  }
  function rememberedPosition() {
    return history &&
      film &&
      identity(history.film) === identity(film) &&
      history.name === lines[line]?.episodes[episode]?.name
      ? history.position
      : 0;
  }
  $("vodProvider").onchange = async (e) => {
    const target = alternatives.find((s) => s.id === e.target.value);
    if (!target) return;
    const token = ++detailEpoch;
    const old = film,
      ep = lines[line]?.episodes[episode]?.name,
      pos = video.currentTime || rememberedPosition();
    stop();
    message("正在查找同名影片…");
    $("vodEpisodes").inert = true;
    $("vodLine").disabled = true;
    $("vodRetry").disabled = true;
    try {
      const page = await invoke("vod_catalog", {
        api: target.api,
        query: old.title,
        page: 1,
      });
      const found = page.films.find(
        (f) =>
          f.title === old.title &&
          (!f.year || !old.year || old.year === f.year),
      );
      if (!found) throw Error("没有找到同名、同年份的影片");
      const data = await invoke("vod_detail", {
        api: target.api,
        id: found.id,
      });
      if (token !== detailEpoch) return;
      source = target;
      applyLines(data, ep, pos);
    } catch (err) {
      if (token === detailEpoch) {
        setProviders();
        message("换源失败：" + err);
      }
    } finally {
      if (token === detailEpoch) {
        $("vodEpisodes").inert = false;
        $("vodLine").disabled = false;
        $("vodRetry").disabled = episode < 0;
      }
    }
  };
  $("vodLine").onchange = (e) => {
    const next = Number(e.target.value),
      name = lines[line]?.episodes[episode]?.name,
      pos = video.currentTime || rememberedPosition();
    stop();
    line = next;
    episode = -1;
    const idx = matchingEpisode(lines[line].episodes, name);
    if (idx >= 0) start(idx, pos);
    else {
      drawEpisodes();
      message("请选择对应分集。");
    }
  };
  $("vodRetry").onclick = () => {
    if (episode >= 0) start(episode, video.currentTime || rememberedPosition());
  };
  $("vodSave").onclick = setBookmark;
  $("vodBack").onclick = browse;
  $("vodResume").onclick = () => {
    if (history) watch(history.film, history);
  };
  $("vodRefresh").onclick = () => load();
  $("vodMore").onclick = () => load(true);
  $("vodBookmarks").onclick = () => {
    savedOnly = !savedOnly;
    load();
  };
  $("vodSearchForm").onsubmit = (e) => {
    e.preventDefault();
    query = $("vodQuery").value.trim();
    savedOnly = false;
    load();
  };
  document.querySelectorAll(".vod-settings-link").forEach(
    (b) =>
      (b.onclick = () => {
        previous = view;
        selectView("settings");
        settings.open();
      }),
  );
  $("vodSettingsBack").onclick = () => {
    if (previous === "watch" && film)
      watch(
        film,
        history && identity(film) === identity(history.film) ? history : null,
      );
    else browse();
  };
  return {
    open() {
      visible = true;
      browse();
      settings.auto();
    },
    close() {
      visible = false;
      detailEpoch++;
      catalogEpoch++;
      busy = false;
      catalogKey = "";
      stop();
      covers.reset();
      settings.close();
    },
  };
}
