// Dayline capture engine: microphone + shared call audio -> speech segments ->
// local Whisper transcription (with call speaker separation) in a worker.
// The worker, ONNX runtime and model files are shared with /dayline-test/.

const WORKER_URL = '../dayline-test/worker.js';
const SR = 16000;

export const MODELS = {
  // Base runs its encoder at full precision on the GPU: half precision garbled the audio features on
  // some GPUs and sent Whisper into repetition loops. The decoder runs on the CPU (its GPU file is over 100 MB).
  'base-gpu': { model: 'onnx-community/whisper-base', device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, label: 'Base on GPU', gpu: true },
  'tiny-gpu': { model: 'onnx-community/whisper-tiny', device: 'webgpu', dtype: 'fp16', label: 'Tiny on GPU', gpu: true, f16: true },
  'tiny-cpu': { model: 'onnx-community/whisper-tiny', device: 'wasm', dtype: 'q8', label: 'Tiny on CPU' },
  'base-cpu': { model: 'onnx-community/whisper-base', device: 'wasm', dtype: 'q8', label: 'Base on CPU' },
};

export async function detectGpu() {
  try {
    if (!navigator.gpu) return { ok: false, why: 'WebGPU not available' };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false, why: 'No GPU adapter' };
    const i = a.info || {};
    return { ok: true, f16: a.features.has('shader-f16'), name: [i.vendor, i.architecture].filter(Boolean).join(' · ') || 'GPU' };
  } catch (e) { return { ok: false, why: e.message }; }
}

export const canShareAudio = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !/Android|iPhone|iPad/i.test(navigator.userAgent);

const WORKLET = "class Tap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0;}process(i){const c=i[0];if(c&&c.length){const L=c[0].length;for(let k=0;k<L;k++){let v=0;for(let ch=0;ch<c.length;ch++)v+=c[ch][k];this.b[this.n++]=v/c.length;if(this.n===this.b.length){this.port.postMessage(this.b);this.b=new Float32Array(2048);this.n=0;}}}return true;}}registerProcessor('tap',Tap);";

export class CaptureEngine {
  // handlers: onLine({t: Date, end: Date, who: 'You'|'Call'|'S<n>', text}), onStatus(text, kind), onLevel(who, 0..1), onStats({...})
  constructor(handlers) {
    this.h = handlers;
    this.worker = null; this.ready = false; this.busy = false;
    this.queue = []; this.pending = {}; this.seq = 0;
    this.diarize = true; this.language = '';
    this.vadThreshold = 0.012;
    this.ctx = null; this.mic = null; this.call = null;
    this.totalAudio = 0; this.totalMs = 0; this.speakers = 0;
  }

  load(modelKey, { diarize = true, speakerMatch = 0.5 } = {}) {
    const cfg = MODELS[modelKey];
    if (this.worker) this.worker.terminate();
    this.ready = false; this.diarize = diarize;
    const files = {};
    return new Promise((resolve, reject) => {
      let alive = false;
      try { this.worker = new Worker(WORKER_URL, { type: 'module' }); }
      catch (e) { reject(new Error('Background workers are blocked here: ' + e.message)); return; }
      this.worker.onerror = (e) => { e.preventDefault?.(); reject(new Error(alive ? (e.message || 'Worker error') : 'The speech engine did not load (' + (e.message || 'script blocked') + ')')); };
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'alive') { alive = true; this.h.onStatus?.('Downloading speech model…'); }
        else if (m.type === 'progress') {
          const p = m.p;
          if (p.file && p.total) files[p.file] = { l: p.loaded || 0, t: p.total };
          if (p.status === 'done' && files[p.file]) files[p.file].l = files[p.file].t;
          let L = 0, T = 0; for (const k in files) { L += files[k].l; T += files[k].t; }
          if (T) this.h.onStatus?.(`Downloading speech model ${(L / 1048576).toFixed(0)} of ${(T / 1048576).toFixed(0)} MB…`, 'progress', L / T);
        } else if (m.type === 'ready') { this.ready = true; this.pump(); resolve(cfg.label + (diarize ? ' + speaker separation' : '')); }
        else if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === 'result') this.onResult(m);
      };
      this.worker.postMessage({ type: 'threshold', value: speakerMatch });
      this.worker.postMessage({ type: 'load', model: cfg.model, device: cfg.device, dtype: cfg.dtype, diarize });
    });
  }

  setSpeakerMatch(v) { this.worker?.postMessage({ type: 'threshold', value: v }); }
  resetSpeakers() { this.worker?.postMessage({ type: 'reset-speakers' }); this.speakers = 0; }

  onResult(m) {
    this.busy = false;
    const job = this.pending[m.id]; delete this.pending[m.id];
    if (job) {
      this.totalAudio += job.secs; this.totalMs += m.ms;
      if (m.speakers) this.speakers = m.speakers;
      this.h.onStats?.({ speed: this.totalAudio / (this.totalMs / 1000), audio: this.totalAudio, queue: this.queue.length, speakers: this.speakers });
      for (const l of m.lines || []) {
        if (isJunk(l.text)) continue;
        this.h.onLine?.({ t: new Date(job.t.getTime() + l.start * 1000), end: new Date(job.t.getTime() + l.end * 1000), who: l.speaker ? 'S' + l.speaker : job.who, text: l.text });
      }
    }
    this.pump();
  }

  enqueue(job) {
    job.secs = job.audio.length / SR;
    this.queue.push(job);
    if (this.queue.length > 12) this.queue.shift();
    this.pump();
  }

  pump() {
    this.h.onStats?.({ queue: this.queue.length });
    if (!this.ready || this.busy || !this.queue.length) return;
    const job = this.queue.shift(); this.busy = true;
    const id = ++this.seq; this.pending[id] = job;
    this.worker.postMessage({ type: 'run', id, audio: job.audio, language: this.language || null, diarize: this.diarize && job.who === 'Call' }, [job.audio.buffer]);
  }

  async getCtx() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
    return this.ctx;
  }

  async attach(stream, who) {
    const c = await this.getCtx(); if (c.state === 'suspended') await c.resume();
    const src = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, 'tap');
    const seg = new Segmenter(who, this), rs = resampler(c.sampleRate);
    node.port.onmessage = (e) => seg.push(rs(e.data));
    src.connect(node);
    return { stop: () => { seg.flush(); src.disconnect(); node.disconnect(); stream.getTracks().forEach((t) => t.stop()); this.h.onLevel?.(who, 0); } };
  }

  async startMic() {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.mic = await this.attach(s, 'You');
    return s.getAudioTracks()[0].label || 'Microphone';
  }
  stopMic() { this.mic?.stop(); this.mic = null; }

  async startCall(onEnded) {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
    const at = s.getAudioTracks(), vt = s.getVideoTracks()[0];
    const surface = vt?.getSettings?.().displaySurface || '';
    if (!at.length) {
      s.getTracks().forEach((t) => t.stop());
      throw new Error(surface === 'window'
        ? 'A single window cannot share audio on Windows. Choose Entire screen (with system audio) or a tab.'
        : 'No audio was shared. Share again and switch on "Also share system audio" (or "tab audio").');
    }
    if (vt) vt.enabled = false;
    this.call = await this.attach(new MediaStream(at), 'Call');
    at[0].addEventListener('ended', () => { this.stopCall(); onEnded?.(); });
    s.getVideoTracks().forEach((t) => t.addEventListener('ended', () => at.forEach((a) => a.stop())));
    return surface === 'monitor' ? 'system audio' : surface === 'browser' ? 'tab audio' : 'call audio';
  }
  stopCall() { this.call?.stop(); this.call = null; }

  get capturing() { return !!(this.mic || this.call); }
}

class Segmenter {
  constructor(who, eng) { this.who = who; this.eng = eng; this.reset(); this.pre = []; }
  reset() { this.buf = []; this.len = 0; this.speech = false; this.silence = 0; this.voiced = 0; this.start = null; }
  push(x) {
    let rms = 0; for (let i = 0; i < x.length; i++) rms += x[i] * x[i]; rms = Math.sqrt(rms / x.length);
    this.eng.h.onLevel?.(this.who, Math.min(1, rms * 9));
    const dur = x.length / SR, thr = this.eng.vadThreshold;
    if (rms > thr) {
      if (!this.speech) { this.speech = true; this.start = new Date(Date.now() - 300); this.buf = this.pre.slice(); this.len = this.buf.reduce((a, b) => a + b.length, 0); this.voiced = 0; }
      this.silence = 0; this.voiced += dur;
    } else if (this.speech) this.silence += dur;
    if (this.speech) { this.buf.push(x); this.len += x.length; }
    else { this.pre.push(x); let pl = 0; for (let j = this.pre.length - 1; j >= 0; j--) { pl += this.pre[j].length; if (pl > 4800) { this.pre = this.pre.slice(j); break; } } }
    if (this.speech && (this.silence > 0.8 || this.len / SR > 15)) this.flush();
  }
  flush() {
    if (this.speech && this.voiced > 0.5) {
      const out = new Float32Array(this.len); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.eng.enqueue({ who: this.who, t: this.start, audio: out });
    }
    this.reset(); this.pre = [];
  }
}

function resampler(fromRate) {
  const ratio = fromRate / SR; let carry = 0;
  return (x) => {
    const n = Math.max(0, Math.floor((x.length - carry) / ratio)), y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = carry + i * ratio, a = Math.floor(p), f = p - a;
      y[i] = (x[a] || 0) * (1 - f) + (x[a + 1] !== undefined ? x[a + 1] : x[a] || 0) * f;
    }
    carry = Math.max(0, carry + n * ratio - x.length);
    return y;
  };
}

function isJunk(t) {
  const s = t.toLowerCase().replace(/[^a-zÀ-ɏ ]/g, '').trim();
  return !s || /^\[.*\]$|^\(.*\)$/.test(t.trim()) || ['thank you', 'thanks for watching', 'you', 'bye'].includes(s);
}
