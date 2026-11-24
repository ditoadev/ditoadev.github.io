// Transcription worker for the Dayline capture test.
// Everything (library, ONNX runtime, model weights) is served from this site,
// so it works on networks that block public CDNs and Hugging Face.
import { pipeline, env } from './vendor/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;

let asr = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    try {
      asr = await pipeline('automatic-speech-recognition', m.model, {
        device: m.device,
        dtype: m.dtype,
        progress_callback: (p) => self.postMessage({ type: 'progress', p }),
      });
      // Warm-up so the first real segment is not slow.
      await asr(new Float32Array(16000), { language: 'en', task: 'transcribe' });
      self.postMessage({ type: 'ready', device: m.device });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'run') {
    const t0 = performance.now();
    try {
      const o = { task: 'transcribe', chunk_length_s: 30 };
      if (m.language) o.language = m.language;
      const out = await asr(m.audio, o);
      self.postMessage({ type: 'result', id: m.id, text: (out.text || '').trim(), ms: performance.now() - t0 });
    } catch (err) {
      self.postMessage({ type: 'result', id: m.id, text: '', error: String((err && err.message) || err), ms: performance.now() - t0 });
    }
  }
};

self.postMessage({ type: 'alive' });
