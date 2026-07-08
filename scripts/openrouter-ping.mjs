#!/usr/bin/env node
/**
 * OpenRouter connectivity ping — a keyless-cost "does my key work?" check.
 *
 * Streams a one-word completion from a FREE model so it costs nothing, and
 * turns OpenRouter's HTTP errors into plain-English guidance (bad key, model
 * not found, rate limit). Use this right after setting OPENROUTER_API_KEY,
 * before spending anything on a paid model.
 *
 * Free-model IDs on OpenRouter rotate constantly, so when you don't name a
 * model this script self-heals: it queries /api/v1/models, picks a currently
 * free one, and retries the next free model if the first has been retired.
 *
 * Usage:
 *   node scripts/openrouter-ping.mjs                       # auto-pick a free model
 *   node scripts/openrouter-ping.mjs "some/model:free" "Say hi"
 *   npm run openrouter:ping
 *   npm run openrouter:ping -- "meta-llama/llama-3.3-70b-instruct:free"
 *
 * Env:
 *   OPENROUTER_API_KEY      required (read from environment or ./.env)
 *   OPENROUTER_PING_MODEL   optional model override (skips auto-discovery)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO      = path.resolve(__dirname, '..');

// A known-free model to fall back on if /models discovery is unavailable.
// Overridable via arg or OPENROUTER_PING_MODEL; kept only as a last resort.
const FALLBACK_FREE_MODEL = 'nvidia/nemotron-3-nano-30b-a3b:free';

// ----- .env loader (same convention as the bench scripts) ------------------
try {
  const envPath = path.join(REPO, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
} catch { /* .env is optional */ }

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error('✗ OPENROUTER_API_KEY is not set.');
  console.error('  Add it to .env  ->  echo \'OPENROUTER_API_KEY=sk-or-v1-...\' >> .env');
  console.error('  or export it     ->  export OPENROUTER_API_KEY=sk-or-v1-...');
  process.exit(2);
}

const argv          = process.argv.slice(2);
const explicitModel = argv[0] || process.env.OPENROUTER_PING_MODEL || null;
const prompt        = argv.slice(1).join(' ') || 'Hello';

const OR_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${KEY}`,
  'HTTP-Referer': 'https://t3mp3st.local/openrouter-ping',
  'X-Title': 't3mp3st-openrouter-ping',
};

// ----- discover currently-free models --------------------------------------
// OpenRouter's /models list carries per-model pricing; "0" prompt+completion
// means it's free right now. Returns [] on any failure so callers fall back.
async function listFreeModels() {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { headers: OR_HEADERS });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || [])
      .filter(m => {
        const p = m.pricing || {};
        return String(p.prompt) === '0' && String(p.completion) === '0';
      })
      .map(m => m.id)
      .filter(id => id.endsWith(':free'));
  } catch { return []; }
}

// ----- single streaming ping -----------------------------------------------
// Returns { ok, status, detail }. Streams content to stdout on success.
async function streamPing(model) {
  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: OR_HEADERS,
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) {
    return { ok: false, status: 0, detail: `network error: ${e.message}` };
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, status: res.status, detail };
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let printed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const token = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (token) { process.stdout.write(token); printed = true; }
      } catch { /* keep-alive / non-JSON line */ }
    }
  }
  process.stdout.write('\n');
  return printed
    ? { ok: true }
    : { ok: false, status: res.status, detail: 'connected but no content returned' };
}

function guidance(status, model) {
  return {
    401: 'Bad or missing key — double-check OPENROUTER_API_KEY.',
    402: 'Out of credits — add balance at https://openrouter.ai/credits (free models still need a $0 account in good standing).',
    404: `Model "${model}" not found — pick a current free one at https://openrouter.ai/models?q=free and pass it as the first arg.`,
    429: 'Rate limited — free models are throttled; wait a moment and retry.',
  }[status] || 'See the raw response above.';
}

// ----- build candidate list, then try in order -----------------------------
let candidates;
if (explicitModel) {
  candidates = [explicitModel];
} else {
  const free = await listFreeModels();
  // Prefer the known-good fallback, then whatever discovery surfaced.
  candidates = [...new Set([FALLBACK_FREE_MODEL, ...free])];
}

let last = null;
for (const model of candidates) {
  console.error(`→ OpenRouter ping  model=${model}  (streaming)\n`);
  const result = await streamPing(model);
  if (result.ok) {
    console.error('\n✓ Key works — streamed a response from OpenRouter.');
    process.exit(0);
  }
  last = { ...result, model };
  // Only a retired/unknown model (404) is worth trying the next candidate for;
  // auth/credit/rate errors won't be fixed by a different model.
  if (result.status !== 404 || candidates.length === 1) break;
  console.error(`  model "${model}" unavailable — trying the next free model...\n`);
}

console.error(`✗ HTTP ${last.status}\n  ${guidance(last.status, last.model)}\n  ${last.detail}`);
process.exit(1);
