import Hls from "hls.js";
import { invoke } from "@tauri-apps/api/core";

// Tauri transports media as bytes, allowing public streams without browser CORS headers.
class MediaLoader extends Hls.DefaultConfig.loader {
  load(context, config, callbacks) {
    this.context = context;
    const stats = this.stats;
    stats.loading.start = performance.now();
    const range =
      context.rangeEnd > (context.rangeStart ?? 0)
        ? [context.rangeStart ?? 0, context.rangeEnd - 1]
        : null;
    invoke("media", {
      url: context.url,
      range,
      radio: this.radio === true,
      vod: this.vod === true,
    })
      .then((raw) => {
        if (this.ended) return;
        const data = new Uint8Array(raw);
        const length = new DataView(data.buffer).getUint32(0, true);
        const url = new TextDecoder().decode(data.subarray(4, length + 4));
        const body = data.subarray(4 + length);
        stats.loading.first = stats.loading.end = performance.now();
        stats.loaded = stats.total = body.byteLength;
        const result =
          context.responseType === "arraybuffer"
            ? body.slice().buffer
            : new TextDecoder().decode(body);
        callbacks.onProgress?.(stats, context, result, null);
        callbacks.onSuccess(
          { url, data: result, code: 200 },
          stats,
          context,
          null,
        );
      })
      .catch((error) => {
        if (!this.ended)
          callbacks.onError(
            { code: 0, text: String(error) },
            context,
            null,
            stats,
          );
      });
  }
  abort() {
    this.ended = true;
    this.stats.aborted = true;
  }
  destroy() {
    this.abort();
  }
}

class RadioLoader extends MediaLoader {
  radio = true;
}

class VodLoader extends MediaLoader {
  vod = true;
}

export class Player {
  constructor(video, events, radio = false, vod = false) {
    this.radio = radio;
    this.vod = vod;
    this.video = video;
    this.events = events;
    this.generation = 0;
  }
  stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.listeners?.abort();
    this.hls?.destroy();
    this.hls = null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
  play(urls, format = "auto") {
    this.stop();
    const [url, ...rest] = urls;
    if (!url) {
      this.events.exhausted();
      return;
    }
    const token = this.generation;
    const current = () => token === this.generation;
    const fail = () => {
      if (current()) this.play(rest, format);
    };
    const watchdog = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(fail, 15000);
    };
    this.events.trying(url);
    this.listeners = new AbortController();
    const listen = (name, callback) =>
      this.video.addEventListener(name, callback, {
        signal: this.listeners.signal,
      });
    listen("playing", () => {
      clearTimeout(this.timer);
      this.events.playing(url);
    });
    listen("waiting", () => {
      if (!this.video.paused) watchdog();
    });
    listen("pause", () => clearTimeout(this.timer));
    listen("error", fail);
    listen("ended", this.vod ? () => this.events.ended?.() : fail);
    const start = () => {
      if (!current()) return;
      this.video.play().catch((error) => {
        if (!current()) return;
        if (error.name === "NotAllowedError") {
          clearTimeout(this.timer);
          this.events.tap();
        } else if (error.name !== "AbortError") fail();
      });
    };
    watchdog();
    const nativeFile = /\.(?:mp4|webm|og[gv])(?:[?#]|$)/i.test(url);
    if (
      (format === "hls" || (format === "auto" && !nativeFile)) &&
      Hls.isSupported()
    ) {
      const h = new Hls({
        loader: this.vod ? VodLoader : this.radio ? RadioLoader : MediaLoader,
        enableWorker: false,
        lowLatencyMode: false,
        maxBufferLength: 25,
      });
      this.hls = h;
      h.on(Hls.Events.ERROR, (_, err) => {
        if (err.fatal) fail();
      });
      h.on(Hls.Events.MANIFEST_PARSED, start);
      h.attachMedia(this.video);
      h.loadSource(url);
    } else {
      invoke("playback_url", {
        url,
        radio: this.radio,
        vod: this.vod,
        playlist: format === "hls",
      })
        .then((local) => {
          if (!current()) return;
          this.video.src = local;
          start();
        })
        .catch(fail);
    }
  }
}

// Use a separate muted player for exactly one route. It never changes the main
// player's stream, its fallback order, or the last successful channel.
export function previewFirstFrame(url, host, signal, vod = false) {
  const video = document.createElement("video");
  video.className = "probe-preview";
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("aria-label", "线路试播");
  host.append(video);
  return new Promise((resolve, reject) => {
    let settled = false;
    let frameCallback;
    const preview = new Player(
      video,
      {
        trying() {},
        playing() {},
        exhausted: () => finish("播放器未能解码出视频帧"),
        tap: () => finish("系统阻止了静音试播"),
      },
      false,
      vod,
    );
    const timer = setTimeout(() => finish("15 秒内未解码出视频帧"), 15000);
    const abort = () => finish("试播已停止");
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (frameCallback != null) video.cancelVideoFrameCallback(frameCallback);
      video.onloadeddata = null;
      preview.stop();
      video.remove();
      if (error) reject(new Error(error));
      else resolve();
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (typeof video.requestVideoFrameCallback === "function") {
        frameCallback = video.requestVideoFrameCallback((_, frame) => {
          finish(frame.width && frame.height ? null : "未取得有效的视频帧");
        });
      } else {
        // HAVE_CURRENT_DATA guarantees a frame at the current playback position.
        video.onloadeddata = () => {
          if (video.readyState >= 2 && video.videoWidth && video.videoHeight)
            finish();
        };
      }
      preview.play([url]);
    } catch (error) {
      finish(String(error));
    }
  });
}
