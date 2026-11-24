// Claude integration: per-episode notes (structured output) and chat over all context.
// The API key is entered by the user and stays on this device.

const MODEL = 'claude-opus-5-5';
let sdk = null;
async function client(apiKey) {
  if (!sdk) sdk = await import('./vendor/anthropic-sdk.mjs');
  const Anthropic = sdk.default;
  return { Anthropic, c: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) };
}

export function speakerName(ep, who, ownerName) {
  if (who === 'You') return ownerName ? `${ownerName} (You)` : 'You';
  if (ep.names && ep.names[who]) return ep.names[who];
  if (/^S\d+$/.test(who)) return 'Speaker ' + who.slice(1);
  return who;
}
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
const day = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function transcriptText(ep, ownerName) {
  return ep.lines.map((l) => `[${hhmm(l.t)}] ${speakerName(ep, l.who, ownerName)}: ${l.text}`).join('\n');
}

const NOTES_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'people', 'decisions', 'promises', 'open_questions', 'topics'],
  properties: {
    title: { type: 'string', description: 'Short specific title, max 8 words' },
    summary: { type: 'string', description: '3-6 sentences: what this conversation was about and what came out of it' },
    people: { type: 'array', items: { type: 'string' }, description: 'People who spoke or were discussed, as named in the transcript' },
    decisions: { type: 'array', items: { type: 'string' } },
    promises: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['who', 'mine', 'what', 'due'],
        properties: {
          who: { type: 'string', description: 'Who made the commitment' },
          mine: { type: 'boolean', description: 'True if the user (You) made it or it is owed to the user' },
          what: { type: 'string' },
          due: { type: 'string', description: 'Due date or time frame as said, or empty string' },
        },
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' }, description: '1-5 short topic or project labels, reused across conversations where possible' },
  },
};

const NOTES_SYSTEM = `You turn automatic transcripts of the user's conversations into notes for their personal memory app.
The transcript comes from on-device speech recognition: expect misheard words, wrong company terms and split sentences. Interpret sensibly, and use the most likely correct spelling of names and terms.
Speaker labels: "You" is the user. "Speaker N" labels are other voices told apart automatically and may be imperfect; "Call" means voices that were not separated.
Only include decisions and promises that were actually stated. Be specific and brief.`;

export async function makeNotes(apiKey, ep, { ownerName, knownTopics = [] } = {}) {
  const { Anthropic, c } = await client(apiKey);
  const header = `Conversation on ${day(ep.start)}, ${hhmm(ep.start)}–${hhmm(ep.end || ep.start)}${ep.source ? ` (${ep.source})` : ''}.` +
    (knownTopics.length ? `\nTopic labels already in use: ${knownTopics.join(', ')}` : '');
  try {
    const r = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
      system: NOTES_SYSTEM,
      messages: [{ role: 'user', content: `${header}\n\n<transcript>\n${transcriptText(ep, ownerName)}\n</transcript>` }],
    });
    if (r.stop_reason === 'refusal') throw new Error('Claude declined to summarize this conversation.');
    const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  } catch (e) { throw friendly(e, Anthropic); }
}

// ---------------- Chat ----------------
const CHAT_SYSTEM = `You are Dayline, the user's personal assistant. You have their captured conversations (meetings and calls), with notes and transcripts, in the context below.
Answer from that context. After each claim that comes from a conversation, cite it as [[ep:ID]] using the episode id. If the context doesn't contain the answer, say so plainly instead of guessing.
Transcripts come from automatic speech recognition and contain errors; read them sensibly and mention uncertainty only when it changes the answer. "You" in transcripts is the user.
The user is usually on a phone: answer briefly and directly, use short bullet lists when they help, and skip preamble.`;

// Build one stable context block (cached across the chat): notes for every episode,
// plus full transcripts of the most recent episodes within a character budget.
export function buildContext(episodes, { ownerName, budget = 300000 } = {}) {
  const eps = episodes.filter((e) => !e.deleted && e.lines?.length).sort((a, b) => b.start - a.start);
  const parts = [`<index count="${eps.length}">`];
  for (const e of eps) {
    const n = e.notes;
    parts.push(`<episode id="${e.id}" date="${day(e.start)} ${hhmm(e.start)}" title="${(n?.title || e.title || '').replace(/"/g, "'")}">` +
      (n ? `\n${n.summary}\nPeople: ${n.people.join(', ')}\nDecisions: ${n.decisions.join('; ') || 'none'}\nPromises: ${n.promises.map((p) => `${p.who}: ${p.what}${p.due ? ` (due ${p.due})` : ''}`).join('; ') || 'none'}\nOpen questions: ${n.open_questions.join('; ') || 'none'}\nTopics: ${n.topics.join(', ')}` : '\n(no notes yet)') +
      `\n</episode>`);
  }
  parts.push('</index>');
  let used = parts.join('\n').length, included = 0;
  const tx = [];
  for (const e of eps) {
    const t = `<transcript id="${e.id}">\n${transcriptText(e, ownerName)}\n</transcript>`;
    if (used + t.length > budget) continue;
    tx.push(t); used += t.length; included++;
  }
  const text = parts.join('\n') + '\n\n<transcripts note="Most recent conversations in full; older ones only as notes above.">\n' + tx.join('\n') + '\n</transcripts>';
  return { text, episodes: eps.length, transcripts: included, chars: text.length };
}

// history: [{role:'user'|'assistant', text}] ; returns final text. onText(delta) streams.
export async function chat(apiKey, contextText, history, onText) {
  const { Anthropic, c } = await client(apiKey);
  const now = new Date();
  const messages = history.map((m, i) => ({
    role: m.role,
    content: i === 0
      ? [{ type: 'text', text: `<context>\n${contextText}\n</context>` }, { type: 'text', text: m.text }]
      : m.text,
  }));
  // Volatile "now" goes in the newest user turn, after the cached prefix.
  const last = messages[messages.length - 1];
  const stamp = `(Now: ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })})\n`;
  if (typeof last.content === 'string') last.content = stamp + last.content;
  else last.content[last.content.length - 1] = { type: 'text', text: stamp + last.content[last.content.length - 1].text };
  try {
    const stream = c.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'low' },
      system: CHAT_SYSTEM,
      messages,
    });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') onText(ev.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('Claude declined to answer this.');
    return final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (e) { throw friendly(e, Anthropic); }
}

function friendly(e, A) {
  if (e instanceof A.AuthenticationError) return new Error('The Claude API key was rejected. Check it in Settings.');
  if (e instanceof A.PermissionDeniedError) return new Error('This API key is not allowed to use this model.');
  if (e instanceof A.RateLimitError) return new Error('Claude is rate limiting requests. Wait a minute and try again.');
  if (e instanceof A.BadRequestError) return new Error('Claude rejected the request: ' + e.message);
  if (e instanceof A.APIConnectionError) return new Error('Could not reach Claude. Check your connection; some work networks block api.anthropic.com.');
  if (e instanceof A.APIError) return new Error(`Claude error ${e.status}: ${e.message}`);
  return e;
}
