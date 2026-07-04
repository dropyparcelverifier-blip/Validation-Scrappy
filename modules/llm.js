// modules/llm.js — LLM weight fallback (spec §3.5 / §5).
//
// Given an exact product title, ask the model for the SHIPPED item weight in
// grams. Strict JSON contract; results are treated as estimates and the caller
// flags medium/low confidence for human review.
//
// Provider-agnostic. User picked Gemini (2026-06-09); Anthropic + OpenAI paths
// are included so the provider can be switched in Settings without code changes.

export const weightPrompt = (title) =>
  `You estimate the shipped weight of a physical product from its title.\n` +
  `Product title: "${title}"\n\n` +
  `Return ONLY a JSON object, no prose, no markdown fences:\n` +
  `{"grams": <number>, "confidence": "high"|"medium"|"low"}\n` +
  `- grams = best estimate of the SHIPPED item weight in grams (include the container/packaging; ` +
  `for liquids the total exceeds the volume in ml ≈ 1 g/ml PLUS the empty container).\n` +
  `- confidence reflects how sure you are given only the title.`;
// Category classifier prompt (spec §7). The model must pick from the dashboard's
// ACTUAL option list and must not match on incidental words in the title.
export const categoryPrompt = (title, brand, options, amazonCategory) =>
  `You map a product to the closest category in a fixed dropdown list.\n` +
  `Product title: "${title}"\n` +
  `Brand: "${brand || 'unknown'}"\n` +
  (amazonCategory ? `Amazon's own category breadcrumb for this product: "${amazonCategory}"\n` : '') +
  `\nChoose the SINGLE closest category from this EXACT list (copy the text verbatim):\n` +
  options.map((o, i) => `${i + 1}. ${o}`).join('\n') + `\n\n` +
  `Rules:\n` +
  `- Prefer the option that best matches Amazon's category breadcrumb above; it is the strongest signal.\n` +
  `- Match the product's ACTUAL type, not incidental words. Example: a novel or Kindle eBook ` +
  `titled "...Secret Baby..." is a Book, NOT baby apparel.\n` +
  `- If the item is a book / Kindle / eBook / digital item and no matching category exists, answer NONE.\n` +
  `- If none of the categories reasonably fits the real product, answer NONE. Do not force a guess.\n\n` +
  `Return ONLY JSON, no prose, no markdown fences:\n` +
  `{"category": "<exact category text from the list, or NONE>", "confidence": "high"|"medium"|"low"}`;

const DEFAULT_MODELS = {
  gemini:    'gemini-2.0-flash',
  anthropic: 'claude-haiku-4-5-20251001',
  openai:    'gpt-4o-mini',
};

// Returns { grams:Number, confidence:'high'|'medium'|'low' } or throws.
export async function estimateWeightGrams({ title, provider, apiKey, model }) {
  if (!title) throw new Error('no title');
  if (!apiKey) throw new Error('no API key — weight fallback disabled');
  return parseResult(await callApi(provider, apiKey, model, weightPrompt(title), 100));
}

// Returns { category:String|'NONE', confidence } or throws.
export async function classifyCategory({ title, brand, options, amazonCategory, provider, apiKey, model }) {
  if (!apiKey) throw new Error('no API key');
  if (!options?.length) throw new Error('no options');
  return parseCategoryResult(await callApi(provider, apiKey, model, categoryPrompt(title, brand, options, amazonCategory), 60));
}

// Combined analysis — weight AND/OR category in a SINGLE call (one chat turn),
// which is far more reliable than two separate web-UI calls per row.
export const analyzePrompt = ({ title, brand, amazonCategory, options, needWeight, needCategory }) => {
  let p = `You analyze ONE e-commerce product. Return ONLY a JSON object, no prose, no markdown fences.\n`;
  p += `Title: "${title}"\nBrand: "${brand || 'unknown'}"\n`;
  if (amazonCategory) p += `Amazon category breadcrumb: "${amazonCategory}"\n`;
  if (needCategory) p += `\nAllowed categories (pick the closest ONE, copied verbatim, or "NONE"):\n` + options.map((o, i) => `${i + 1}. ${o}`).join('\n') + `\n`;
  p += `\nReturn JSON with exactly these keys:\n`;
  if (needWeight) p += `- "grams": estimated SHIPPED weight in grams (number). Include the container/packaging — a glass bottle, jar, or box often adds 10–80 g. For any liquid/cosmetic/perfume the total MUST exceed the liquid volume (≈1 g per ml) PLUS the empty container, so e.g. a "4 ml" glass perfume cannot weigh only a few grams. "weightConfidence": "high"|"medium"|"low"\n`;
  if (needCategory) p += `- "category": the closest allowed category VERBATIM, or "NONE". Rules:\n` +
    `   • Map by the CORE PRODUCT NOUN (what the item physically IS), not the activity/brand/use. ` +
    `Examples: "Motorcycle Jacket" → an apparel JACKET (e.g. Apparel ...), NOT helmets/gloves/automotive; ` +
    `"Yoga Mat" → a mat; a novel "...Secret Baby..." → a Book, not baby apparel.\n` +
    `   • Prefer the Amazon breadcrumb when present.\n` +
    `   • Use "NONE" for books/eBooks/digital, or when nothing fits.\n` +
    `   Also return "categoryConfidence": "high"|"medium"|"low".\n`;
  return p;
};

export function parseAnalyze(text, { needWeight, needCategory }) {
  if (!text) throw new Error('empty LLM response');
  const m = text.match(/\{[\s\S]*\}/);
  const o = JSON.parse(m ? m[0] : text);
  const conf = c => { c = String(c || 'low').toLowerCase(); return ['high', 'medium', 'low'].includes(c) ? c : 'low'; };
  const out = {};
  if (needWeight) { const g = Number(o.grams); if (Number.isFinite(g) && g > 0) { out.grams = Math.round(g); out.weightConfidence = conf(o.weightConfidence); } }
  if (needCategory) { out.category = String(o.category || '').trim(); out.categoryConfidence = conf(o.categoryConfidence); }
  return out;
}

export async function analyzeApi({ title, brand, amazonCategory, options, needWeight, needCategory, provider, apiKey, model }) {
  if (!apiKey) throw new Error('no API key');
  const prompt = analyzePrompt({ title, brand, amazonCategory, options, needWeight, needCategory });
  return parseAnalyze(await callApi(provider, apiKey, model, prompt, 150), { needWeight, needCategory });
}

export function parseCategoryResult(text) {
  if (!text) throw new Error('empty LLM response');
  const m = text.match(/\{[\s\S]*\}/);
  const obj = JSON.parse(m ? m[0] : text);
  const category = String(obj.category || '').trim();
  let confidence = String(obj.confidence || 'low').toLowerCase();
  if (!['high', 'medium', 'low'].includes(confidence)) confidence = 'low';
  return { category, confidence };
}

async function callApi(provider, apiKey, model, prompt, maxTokens) {
  const prov = (provider || 'gemini').toLowerCase();
  const mdl = (model && model.trim()) || DEFAULT_MODELS[prov] || DEFAULT_MODELS.gemini;
  if (prov === 'anthropic') return callAnthropic(apiKey, mdl, prompt, maxTokens);
  if (prov === 'openai')    return callOpenAI(apiKey, mdl, prompt);
  return callGemini(apiKey, mdl, prompt);
}

export function parseWeightResult(text) { return parseResult(text); }
function parseResult(text) {
  if (!text) throw new Error('empty LLM response');
  // Tolerate stray fences/prose: grab the first {...} block.
  const m = text.match(/\{[\s\S]*\}/);
  const obj = JSON.parse(m ? m[0] : text);
  const grams = Number(obj.grams);
  if (!Number.isFinite(grams) || grams <= 0) throw new Error(`bad grams in LLM response: ${text.slice(0, 120)}`);
  let confidence = String(obj.confidence || 'low').toLowerCase();
  if (!['high', 'medium', 'low'].includes(confidence)) confidence = 'low';
  return { grams: Math.round(grams), confidence };
}

async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callAnthropic(apiKey, model, prompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 100,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.content?.[0]?.text || '';
}

async function callOpenAI(apiKey, model, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}
