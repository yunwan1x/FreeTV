import { Player } from "./player.js";

export function createWall({
  onFocus,
  onStatus,
  onPlaying,
  onChoose,
  playRoutes,
}) {
  const wall = document.getElementById("wall");
  const tiles = [];
  const narrow = matchMedia("(max-width:760px)");
  narrow.addEventListener("change", () => tiles.forEach(draw));
  let focused;
  function createTile() {
    const node = document
      .getElementById("tileTemplate")
      .content.firstElementChild.cloneNode(true);
    const video = node.querySelector("video");
    const cover = node.querySelector(".cover");
    const tag = node.querySelector(".screen-tag");
    const button = node.querySelector(".screen-play");
    const tile = {
      node,
      video,
      cover,
      tag,
      button,
      channel: null,
      url: "",
      message: "",
    };
    function report(message) {
      tile.message = message;
      if (tile === focused) onStatus(tile);
    }
    tile.player = new Player(video, {
      trying(url) {
        tile.url = url;
        cover.hidden = true;
        report("正在连接线路 " + (tile.channel.routes.indexOf(url) + 1) + "…");
      },
      playing(url) {
        onPlaying(tile.channel, url);
        report("正在播放 · 线路 " + (tile.channel.routes.indexOf(url) + 1));
      },
      exhausted() {
        tile.url = "";
        cover.hidden = false;
        button.textContent = "重新播放";
        report("线路暂不可用，可打开「线路」检测或重试。");
      },
      tap() {
        report("请点画面中的播放键继续");
      },
    });
    tile.assign = (channel, start) => {
      tile.player.stop();
      tile.channel = channel;
      tile.url = "";
      tile.message = "";
      cover.hidden = false;
      draw(tile);
      if (start && channel) tile.player.play(playRoutes(channel));
    };
    video.addEventListener("pause", () => {
      if (tile.url && video.paused && !video.ended) report("已暂停");
    });
    video.addEventListener("loadeddata", () => {
      if (tile === focused) onStatus(tile);
    });
    video.addEventListener("volumechange", () => {
      if (tile !== focused && !video.muted) video.muted = true;
    });
    node.addEventListener("pointerdown", () => focus(tile));
    tag.onclick = () => focus(tile);
    button.onclick = () => {
      focus(tile);
      if (tile.channel) tile.player.play(playRoutes(tile.channel));
      else onChoose();
    };
    wall.append(node);
    return tile;
  }
  function draw(tile) {
    const number = tiles.indexOf(tile) + 1;
    const { channel, node, tag } = tile;
    const active = tile === focused;
    tile.video.controls = !(tiles.length > 1 && narrow.matches);
    node.classList.toggle("selected", active);
    node.classList.toggle("vacant", !channel);
    tag.setAttribute("aria-pressed", String(active));
    tag.textContent =
      number +
      " · " +
      (channel?.name || "待选频道") +
      (active ? " · 主声道" : "");
    node.querySelector(".stamp").textContent =
      channel?.group || "画面 " + number;
    node.querySelector("h2").textContent = channel?.name || "选择频道";
    tile.button.textContent = channel ? "播放直播" : "从列表选台";
  }
  function focus(tile) {
    if (focused === tile) return;
    const old = focused;
    focused = tile;
    if (old) {
      old.video.muted = true;
      draw(old);
    }
    tile.video.muted = false;
    draw(tile);
    onFocus(tile);
  }
  function layout(size) {
    if (tiles.length > size) {
      const keep = tiles.slice(0, size);
      if (!keep.includes(focused)) keep[size - 1] = focused;
      for (const tile of tiles.filter((t) => !keep.includes(t))) {
        tile.player.stop();
        tile.node.remove();
      }
      tiles.splice(0, tiles.length, ...keep);
    }
    while (tiles.length < size) {
      const tile = createTile();
      tile.video.muted = true;
      tiles.push(tile);
    }
    wall.dataset.layout = size;
    tiles.forEach(draw);
    for (const button of document.querySelectorAll("#layouts button")) {
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.layout) === size),
      );
    }
    if (!focused) focus(tiles[0]);
  }
  return {
    layout,
    tiles,
    get focused() {
      return focused;
    },
    stopAll() {
      for (const tile of tiles) tile.assign(tile.channel, false);
      onFocus(focused);
    },
  };
}
