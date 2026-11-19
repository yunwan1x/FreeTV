import { previewFirstFrame } from "./player.js";
import { invoke } from "@tauri-apps/api/core";

const directory =
  "https://raw.githubusercontent.com/hafrey1/LunaTV-config/main/jin18.json";
const builtin = [
  {
    key: "www.moduzy.net",
    name: "魔都资源",
    api: "https://www.mdzyapi.com/api.php/provide/vod",
    enabled: true,
  },
  {
    key: "ikunzy.com",
    name: "iKun 资源",
    api: "https://ikunzyapi.com/api.php/provide/vod",
    enabled: true,
  },
  {
    key: "360zy.com",
    name: "360 资源",
    api: "https://360zyzz.com/api.php/provide/vod",
    enabled: false,
  },
];
export const mediathek = "https://mediathekviewweb.de/api/query";
const international = {
  key: "mediathek",
  name: "MediathekView",
  api: mediathek,
  enabled: false,
};
const $ = (id) => document.getElementById(id);
export function setupVodSettings(read, write, changed) {
  const prefs = read("vod-settings-v1", {
    auto: true,
    groups: [],
    overrides: {},
    checks: {},
  });
  const pending = new Set(),
    errors = new Map();
  let visible = false;
  let probe;
  const save = () => write("vod-settings-v1", prefs);
  function groups() {
    const synced = prefs.groups.find((g) => g.address === directory);
    const custom = prefs.groups.filter((g) => g.address !== directory);
    // Keep existing custom source IDs (including favorites and opt-outs) on overlap.
    const customApis = new Set(
      custom.flatMap((g) => g.sources.map((s) => s.api)),
    );
    const seedKeys = new Set(builtin.map((s) => s.key));
    const discovered = (synced?.sources || []).filter(
      (s) => !seedKeys.has(s.key) && !customApis.has(s.api) && s.api !== mediathek,
    );
    return [
      {
        address: directory,
        name: "LunaTV 点播源集合",
        needsDiscovery: !synced?.fullDirectory,
        updated: synced?.updated,
        sources: [
          ...builtin.map((s) => ({
            ...s,
            api: synced?.sources.find((v) => v.key === s.key)?.api || s.api,
          })),
          ...discovered,
        ],
      },
      {
        address: "international",
        name: "国际公共媒体",
        sources: [international],
      },
      ...custom,
    ];
  }
  function sources() {
    const seen = new Set(),
      result = [];
    for (const g of groups())
      for (const s of g.sources) {
        if (seen.has(s.api)) continue;
        seen.add(s.api);
        const id = g.address + "|" + s.key;
        result.push({
          ...s,
          id,
          group: g.address,
          enabled: prefs.overrides[id] ?? s.enabled ?? true,
        });
      }
    return result;
  }
  function record(id, kind, message) {
    prefs.checks[id] = {
      ...prefs.checks[id],
      [kind]: { message, time: Date.now() },
    };
    save();
    if (visible) render();
  }
  async function checkSource(source) {
    probe?.controller.abort();
    const controller = new AbortController(),
      signal = controller.signal;
    probe = { controller, id: source.id };
    let stage = "catalog";
    render();
    try {
      const page = await invoke("vod_catalog", {
        api: source.api,
        query: "",
        page: 1,
      });
      if (signal.aborted) return;
      record(source.id, "catalog", "目录可读");
      const first = page.films[0];
      stage = "play";
      if (!first) throw Error("目录为空");
      const film = first.lines.length
        ? first
        : await invoke("vod_detail", { api: source.api, id: first.id });
      if (signal.aborted) return;
      const url = film.lines[0]?.episodes[0]?.url;
      if (!url) throw Error("无播放地址");
      await previewFirstFrame(url, $("vodProbeHost"), signal, true);
      if (!signal.aborted)
        record(source.id, "play", "试播成功 · " + film.title);
    } catch (e) {
      if (!signal.aborted)
        record(
          source.id,
          stage,
          (stage === "play" ? "试播失败 · " : "目录失败 · ") + String(e),
        );
    } finally {
      if (probe?.controller === controller) {
        probe = null;
        render();
      }
    }
  }
  function button(label, fn) {
    const b = document.createElement("button");
    b.className = "outline";
    b.textContent = label;
    b.onclick = fn;
    return b;
  }
  function render() {
    if (!visible) return;
    $("vodAuto").checked = prefs.auto;
    const all = sources();
    $("vodSources").replaceChildren(
      ...groups().map((g) => {
        const card = document.createElement("section");
        card.className = "vod-source";
        const head = document.createElement("div");
        head.className = "between";
        const title = document.createElement("h3");
        const entries = all.filter((s) => s.group === g.address);
        title.textContent = g.name + " · " + entries.length + " 个源";
        head.append(title);
        if (g.address !== "international") {
          const tools = document.createElement("div");
          tools.className = "vod-buttons";
          const sync = button(pending.has(g.address) ? "同步中…" : "同步", () =>
            syncGroup(g.address, g.name),
          );
          sync.disabled = pending.has(g.address);
          tools.append(sync);
          if (g.address !== directory)
            tools.append(
              button("移除", () => {
                prefs.groups = prefs.groups.filter(
                  (v) => v.address !== g.address,
                );
                save();
                render();
                changed();
              }),
            );
          head.append(tools);
        }
        const note = document.createElement("small");
        note.textContent =
          errors.get(g.address) ||
          (g.updated
            ? "最近同步 " + new Date(g.updated).toLocaleString("zh-CN")
            : g.address === "international"
              ? "德国及欧洲公共广播机构节目"
              : "尚未同步");
        card.append(head, note);
        for (const s of entries) {
          const row = document.createElement("div");
          row.className = "vod-source-row";
          const label = document.createElement("span"),
            name = document.createElement("b"),
            status = document.createElement("small");
          name.textContent = s.name;
          const checks = prefs.checks[s.id];
          const describe = (c) =>
            c.message +
            " · " +
            new Date(c.time).toLocaleString("zh-CN", {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
          status.textContent =
            [
              checks?.catalog && describe(checks.catalog),
              checks?.play && describe(checks.play),
            ]
              .filter(Boolean)
              .join("　") || "尚无检测记录";
          label.append(name, status);
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = s.enabled;
          input.setAttribute("aria-label", "启用" + s.name);
          input.onchange = () => {
            prefs.overrides[s.id] = input.checked;
            save();
            changed();
          };
          const tools = document.createElement("div");
          tools.className = "vod-buttons";
          const running = probe?.id === s.id;
          const test = button(running ? "停止检测" : "试播检测", () =>
            running ? probe?.controller.abort() : checkSource(s),
          );
          test.setAttribute(
            "aria-label",
            (running ? "停止检测" : "试播检测") + s.name,
          );
          tools.append(test, input);
          row.append(label, tools);
          card.append(row);
        }
        return card;
      }),
    );
  }
  async function syncGroup(address, name, adding = false) {
    if (pending.has(address)) return;
    pending.add(address);
    errors.delete(address);
    render();
    try {
      const list = await invoke("vod_sources", { address });
      if (!adding && !groups().some((g) => g.address === address)) return;
      const next = { address, name, sources: list, updated: Date.now() };
      if (address === directory) {
        next.fullDirectory = true;
        // Preserve last-known URLs for bundled fallback sources absent in this snapshot.
        const keys = new Set(list.map((s) => s.key));
        const previous = groups()[0].sources;
        for (const seed of builtin) {
          if (!keys.has(seed.key))
            next.sources.push(previous.find((s) => s.key === seed.key));
        }
      }
      const index = prefs.groups.findIndex((g) => g.address === address);
      if (index < 0) prefs.groups.push(next);
      else prefs.groups[index] = next;
      save();
      changed();
      if (adding) {
        $("vodSubUrl").value = "";
        $("vodImportMsg").textContent = "已导入 " + list.length + " 个接口";
      }
    } catch (e) {
      errors.set(address, "同步失败 · " + String(e));
      if (adding) $("vodImportMsg").textContent = String(e);
    } finally {
      pending.delete(address);
      render();
    }
  }
  function refresh(staleOnly = false) {
    return Promise.all(
      groups()
        .filter(
          (g) =>
            g.address !== "international" &&
            (!staleOnly ||
              g.needsDiscovery ||
              Date.now() - (g.updated || 0) > 86400000),
        )
        .map((g) => syncGroup(g.address, g.name)),
    );
  }
  $("vodAuto").onchange = (e) => {
    prefs.auto = e.target.checked;
    save();
    if (prefs.auto) refresh(true);
  };
  $("vodSyncAll").onclick = () => refresh();
  $("vodAddForm").onsubmit = (e) => {
    e.preventDefault();
    let url;
    try {
      url = new URL($("vodSubUrl").value.trim());
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error();
    } catch {
      $("vodImportMsg").textContent = "请输入 HTTP(S) 订阅地址";
      return;
    }
    if (groups().some((g) => g.address === url.href)) {
      $("vodImportMsg").textContent = "已存在此订阅";
      return;
    }
    $("vodImportMsg").textContent = "正在读取订阅…";
    syncGroup(url.href, url.hostname, true);
  };
  return {
    sources,
    record,
    open() {
      visible = true;
      render();
    },
    close() {
      visible = false;
      probe?.controller.abort();
    },
    auto() {
      if (prefs.auto) refresh(true);
    },
  };
}
