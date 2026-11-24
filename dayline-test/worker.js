// Transcription worker for the Dayline capture test.
// Everything (library, ONNX runtime, model weights) is served from this site,
// so it works on networks that block public CDNs and Hugging Face.
import { pipeline, env, AutoProcessor, AutoModel, AutoModelForAudioFrameClassification } from './vendor/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;

const SEG_ID = 'onnx-community/pyannote-segmentation-3.0';
const EMB_ID = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const SR = 16000;

let asr = null;
let seg = null; // { proc, model }
let emb = null; // { proc, model }
let speakers = []; // [{ id, centroid: Float32Array (unit length), n }]
let matchThreshold = 0.5;

const progress = (p) => self.postMessage({ type: 'progress', p });

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    try {
      asr = await pipeline('automatic-speech-recognition', m.model, { device: m.device, dtype: m.dtype, progress_callback: progress });
      if (m.diarize) {
        seg = {
          proc: await AutoProcessor.from_pretrained(SEG_ID, { progress_callback: progress }),
          model: await AutoModelForAudioFrameClassification.from_pretrained(SEG_ID, { device: 'wasm', dtype: 'fp32', progress_callback: progress }),
        };
        emb = {
          proc: await AutoProcessor.from_pretrained(EMB_ID, { progress_callback: progress }),
          model: await AutoModel.from_pretrained(EMB_ID, { device: 'wasm', dtype: 'fp32', progress_callback: progress }),
        };
      } else { seg = emb = null; }
      speakers = [];
      // Warm-up so the first real segment is not slow.
      await asr(new Float32Array(SR), { language: 'en', task: 'transcribe' });
      self.postMessage({ type: 'ready', diarize: !!seg });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'threshold') {
    matchThreshold = m.value;
  } else if (m.type === 'reset-speakers') {
    speakers = [];
  } else if (m.type === 'run') {
    const t0 = performance.now();
    try {
      let lines;
      if (m.diarize && seg && emb) lines = await diarizeAndTranscribe(m.audio, m.language);
      else {
        const text = await transcribe(m.audio, m.language);
        lines = text ? [{ start: 0, end: m.audio.length / SR, speaker: null, text }] : [];
      }
      self.postMessage({ type: 'result', id: m.id, lines, ms: performance.now() - t0, speakers: speakers.length });
    } catch (err) {
      self.postMessage({ type: 'result', id: m.id, lines: [], error: String((err && err.message) || err), ms: performance.now() - t0 });
    }
  }
};

async function transcribe(audio, language) {
  const secs = audio.length / SR;
  const o = {
    task: 'transcribe',
    chunk_length_s: 30,
    // Guards against Whisper's repetition loops ("we we we we …"):
    // no repeated 3-word phrases, and a token budget that fits the clip's length
    // (fast speech is ~4-5 tokens per second).
    no_repeat_ngram_size: 3,
    max_new_tokens: Math.min(440, Math.ceil(secs * 7) + 12),
  };
  if (language) o.language = language;
  const out = await asr(audio, o);
  return cleanText(out.text || '');
}

// Remove any loop that still gets through: a word or short phrase repeated 4+ times in a row
// is collapsed to one occurrence; a line that is nothing but such a loop is dropped.
function cleanText(text) {
  let words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  let looped = false;
  for (let n = 1; n <= 4; n++) {
    const out = [];
    for (let i = 0; i < words.length;) {
      let reps = 1;
      const unit = words.slice(i, i + n).map(norm).join(' ');
      while (unit && i + (reps + 1) * n <= words.length && words.slice(i + reps * n, i + (reps + 1) * n).map(norm).join(' ') === unit) reps++;
      if (reps >= 4) { out.push(...words.slice(i, i + n)); i += reps * n; looped = true; }
      else { out.push(words[i]); i++; }
    }
    words = out;
  }
  const result = words.join(' ').trim();
  // After collapsing, a loop leaves one or two words of "content": treat that as noise.
  if (looped && words.length <= 2) return '';
  return result;
}

// ---- Speaker separation -------------------------------------------------
// 1. pyannote finds speaker turns inside this segment (local labels).
// 2. Each local speaker gets a voice fingerprint (WeSpeaker embedding).
// 3. Fingerprints are matched against everyone heard so far this session,
//    so "Speaker 2" stays the same person across the whole meeting.
// 4. Each turn is transcribed on its own.
async function diarizeAndTranscribe(audio, language) {
  const dur = audio.length / SR;
  const { logits } = await seg.model(await seg.proc(audio));
  let turns = seg.proc.post_process_speaker_diarization(logits, audio.length)[0]
    .filter((t) => t.id !== 0) // 0 = no speech
    .map((t) => ({ local: t.id, start: t.start, end: Math.min(t.end, dur) }));

  // Overlap classes (4-6) and very short blips join the neighbouring turn.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if ((t.local > 3 || t.end - t.start < 0.5) && turns.length > 1) {
      const prev = turns[i - 1], next = turns[i + 1];
      const host = prev || next;
      host.start = Math.min(host.start, t.start); host.end = Math.max(host.end, t.end);
      turns.splice(i, 1); i--;
    }
  }
  // Merge consecutive turns of the same local speaker.
  turns = turns.reduce((acc, t) => {
    const last = acc[acc.length - 1];
    if (last && last.local === t.local && t.start - last.end < 0.6) last.end = t.end; else acc.push({ ...t });
    return acc;
  }, []);
  if (!turns.length) return []; // no speech found: don't invent a speaker from noise

  // One fingerprint per local speaker, from all of their audio in this segment.
  const localToGlobal = {};
  for (const local of [...new Set(turns.map((t) => t.local))]) {
    const parts = turns.filter((t) => t.local === local).map((t) => audio.subarray(Math.floor(t.start * SR), Math.ceil(t.end * SR)));
    const total = parts.reduce((a, p) => a + p.length, 0);
    if (total < SR * 0.8) continue; // too short to fingerprint reliably
    const joined = new Float32Array(total); let o = 0;
    for (const p of parts) { joined.set(p, o); o += p.length; }
    localToGlobal[local] = await matchSpeaker(await fingerprint(joined));
  }

  const lines = [];
  for (const t of turns) {
    const clip = audio.slice(Math.floor(t.start * SR), Math.ceil(t.end * SR));
    if (clip.length < SR * 0.4) continue;
    const text = await transcribe(clip, language);
    if (!text) continue;
    let speaker = localToGlobal[t.local];
    if (speaker === undefined) speaker = lines.length ? lines[lines.length - 1].speaker : (speakers.length ? speakers[speakers.length - 1].id : await matchSpeaker(null));
    lines.push({ start: t.start, end: t.end, speaker, text });
  }
  return lines;
}

async function fingerprint(clip) {
  const out = await emb.model(await emb.proc(clip));
  const v = Float32Array.from(out.last_hidden_state.data);
  return normalize(v);
}

async function matchSpeaker(v) {
  if (!v) { const id = speakers.length + 1; speakers.push({ id, centroid: null, n: 0 }); return id; }
  let best = null, bestSim = -1;
  for (const s of speakers) {
    if (!s.centroid) continue;
    const sim = dot(v, s.centroid);
    if (sim > bestSim) { bestSim = sim; best = s; }
  }
  if (best && bestSim >= matchThreshold) {
    // Running average keeps the fingerprint stable as more speech arrives.
    const c = best.centroid, n = Math.min(best.n, 20);
    for (let i = 0; i < c.length; i++) c[i] = (c[i] * n + v[i]) / (n + 1);
    best.centroid = normalize(c); best.n++;
    return best.id;
  }
  const id = speakers.length + 1;
  speakers.push({ id, centroid: v, n: 1 });
  return id;
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function normalize(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; }

self.postMessage({ type: 'alive' });
