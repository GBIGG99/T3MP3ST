#!/usr/bin/env node
/**
 * OpenRouter connectivity ping — a keyless-cost "does my key work?" check.
 *
 * Streams a one-word completion from a FREE model so it costs nothing, and
 * turns OpenRouter's HTTP errors into plain-English guidance (bad key, model
 * not found, rate limit). Use this right after setting OPENROUTER_API_KEY,
 * before spending anything on a paid model.
 *
 * Usage:
 *   node scripts/openrouter-ping.mjs
 *   node scripts/openrouter-ping.mjs "google/gemma-3-27b-it:free" "Say hi"
 *   npm run openrouter:ping
 *   npm run openrouter:ping -- "meta-llama/llama-3.3-70b-instruct:free"
 *
 * Env:
 *   OPENROUTER_API_KEY      required (read from environment or ./.env)
 *   OPENROUTER_PING_MODEL   optional default model override
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO      = path.resolve(__dirname, '..');

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

const argv    = process.argv.slice(2);
const model   = argv[0] || process.env.OPENROUTER_PING_MODEL || 'google/gemma-3-27b-it:free';
const prompt  = argv.slice(1).join(' ') || 'Hello';

console.error(`→ OpenRouter ping  model=${model}  (streaming)\n`);

const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${KEY}`,
    'HTTP-Referer': 'https://t3mp3st.local/openrouter-ping',
    'X-Title': 't3mp3st-openrouter-ping',
  },
  body: JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  }),
});

if (!res.ok) {
  const detail = (await res.text()).slice(0, 300);
  const hint = {
    401: 'Bad or missing key — double-check OPENROUTER_API_KEY.',
    402: 'Out of credits — add balance at https://openrouter.ai/credits (free models still need a $0 account in good standing).',
    404: `Model "${model}" not found — pick a current free one at https://openrouter.ai/models?q=free and pass it as the first arg.`,
    429: 'Rate limited — free models are throttled; wait a moment and retry.',
  }[res.status] || 'See the raw response above.';
  console.error(`✗ HTTP ${res.status}\n  ${hint}\n  ${detail}`);
  process.exit(1);
}

// ----- stream the Server-Sent Events body ----------------------------------
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
if (printed) console.error('\n✓ Key works — streamed a response from OpenRouter.');
else { console.error('\n✗ Connected but got no content back — try a different model.'); process.exit(1); }
