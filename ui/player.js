import Hls from 'hls.js';
import {invoke} from '@tauri-apps/api/core';

// Tauri transports media as bytes, allowing public streams without browser CORS headers.
class MediaLoader extends Hls.DefaultConfig.loader {
  load(context, config, callbacks) {
    this.context = context;
    const stats = this.stats;
    stats.loading.start = performance.now();
    const range = context.rangeEnd > (context.rangeStart ?? 0) ? [context.rangeStart ?? 0, context.rangeEnd - 1] : null;
    invoke('media', {url: context.url, range}).then(raw => {
      if (this.ended) return;
      const data = new Uint8Array(raw);
      const length = new DataView(data.buffer).getUint32(0, true);
      const url = new TextDecoder().decode(data.subarray(4, length + 4));
      const body = data.subarray(4 + length);
      stats.loading.first = stats.loading.end = performance.now();
      stats.loaded = stats.total = body.byteLength;
      const result = context.responseType === 'arraybuffer' ? body.slice().buffer : new TextDecoder().decode(body);
      callbacks.onProgress?.(stats, context, result, null);
      callbacks.onSuccess({url, data:result, code:200}, stats, context, null);
    }).catch(error => {
      if (!this.ended) callbacks.onError({code:0, text:String(error)}, context, null, stats);
    });
  }
  abort() { this.ended = true; this.stats.aborted = true; }
  destroy() { this.abort(); }
}

export class Player {
  constructor(video, events) { this.video = video; this.events = events; this.generation = 0; }
  stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.listeners?.abort();
    this.hls?.destroy();
    this.hls = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }
  play(urls) {
    this.stop();
    const [url,...rest] = urls;
    if (!url) { this.events.exhausted(); return; }
    const token = this.generation;
    const current = () => token === this.generation;
    const fail = () => { if (current()) this.play(rest); };
    const watchdog = () => {clearTimeout(this.timer); this.timer = setTimeout(fail,15000);};
    this.events.trying(url);
    this.listeners = new AbortController();
    const listen = (name,callback) => this.video.addEventListener(name, callback,{signal:this.listeners.signal});
    listen('playing', () => {clearTimeout(this.timer); this.events.playing(url);});
    listen('waiting', () => {if(!this.video.paused) watchdog();});
    listen('pause', () => clearTimeout(this.timer));
    listen('error',fail);
    listen('ended',fail);
    const start = () => {
      if (!current()) return;
      this.video.play().catch(error => {
        if (!current()) return;
        if(error.name === 'NotAllowedError') {clearTimeout(this.timer);this.events.tap();}
        else if(error.name !== 'AbortError') fail();
      });
    };
    watchdog();
    const nativeFile = /\.(?:mp4|webm|og[gv])(?:[?#]|$)/i.test(url);
    if (!nativeFile && Hls.isSupported()) {
      const h = new Hls({loader:MediaLoader,enableWorker:false,lowLatencyMode:false,maxBufferLength:25});
      this.hls = h;
      h.on(Hls.Events.ERROR, (_,err) => {if(err.fatal) fail();});
      h.on(Hls.Events.MANIFEST_PARSED, start);
      h.attachMedia(this.video);
      h.loadSource(url);
    } else {
      this.video.src = url;
      start();
    }
  }
}
