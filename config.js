// config.js  (ES module — imported by the service worker)
// Single source of defaults + storage keys for the Dropy Auto-Validator.
//
// Content scripts are plain (non-module) scripts and CANNOT import this file;
// anything they need is passed to them in the message payload by the worker,
// or duplicated locally where it must live in-page (see content/amazon.js
// parsing constants). Keep this module dependency-free so it loads in the SW.

// ----------------------------------------------------------------------------
// Storage keys (chrome.storage.local). Namespaced with `dav` (Dropy Auto-Validator).
// ----------------------------------------------------------------------------
export const K = {
  SETTINGS:        'davSettings',         // user settings object (see DEFAULT_SETTINGS)
  RUN_STATE:       'davRunState',          // { running, paused, pausedByCaptcha, status, page, ... }
  PROCESSED:       'davProcessedAsins',    // array of ASIN strings already finished (dedupe + resume)
  ROW_RECORDS:     'davRowRecords',        // { [asin]: per-row audit record } for the session
  LOG:             'davLog',               // ring buffer of { ts, text, kind, asin? }
  COUNTERS:        'davCounters',          // { passed, linkNf, usaLinkNf, flagged, processed }
  LAST_SCAN:       'davLastScan',          // last SCAN dump (for the panel to re-render)
};

export const LOG_MAX = 500;

// ----------------------------------------------------------------------------
// Defaults. Everything here is overridable from the side-panel Settings tab and
// persisted under K.SETTINGS.
// ----------------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  // The dashboard origin the dashboard content script is injected on. Configurable
  // because it moves (Tailscale IP today, may become localhost or a real domain).
  // Origin only (scheme://host[:port]) — no path.
  dashboardOrigin: 'http://100.82.234.106:3000',

  // BSR strictly below this => RS (restock); at/above => DP (dropship).
  bsrThreshold: 50000,

  // Which marketplace's BSR decides RS vs DP. User decision (2026-06-09):
  // **India BSR** (the amazon.in page), NOT the USA link. 'india' | 'usa' | 'lower'.
  funnelBsrSource: 'india',

  // Randomised human-paced delay between Amazon page loads (ms). A uniform pick
  // in [min, max] each time. Lower = faster but slightly more CAPTCHA risk
  // (auto-handled). Raise these if Amazon shows CAPTCHAs often.
  throttleMinMs: 2000,
  throttleMaxMs: 5000,

  // Per-Amazon-page hard timeout (ms) before one retry, then flag-and-continue.
  pageTimeoutMs: 30000,

  // Bring the Amazon tab being scraped to the foreground so you can watch which
  // product it's working on. Turn off to keep it in the background.
  showWorkingTab: true,

  // LIVE by default (dry-run off) — actually clicks Pass / Move Fail / Link NF.
  // Turn dry-run ON in the Run tab to fill fields without committing.
  dryRun: false,

  // Weight fallback source (spec §5). User chose to drive the chat WEB UI in
  // their logged-in session (2026-06-09) — no API key needed.
  //   'gemini-web'  -> https://gemini.google.com/app?hl=en-IN  (default)
  //   'chatgpt-web' -> https://chatgpt.com/
  //   'api'         -> REST API using llmProvider/llmApiKey/llmModel below
  //   'off'         -> don't estimate; flag missing weights for human review
  weightMode: 'gemini-web',

  // Weight cross-verification (2026-06-11): every row's Amazon-listed weight is
  // checked against an independent LLM estimate. They are treated as agreeing
  // when within this factor (e.g. 2.0 = within 2×); beyond it — or when the
  // Amazon weight is below the product's own liquid volume — the LLM value wins
  // and the row is flagged "weight corrected". Raise to be more permissive of
  // Amazon's value, lower to correct more aggressively.
  weightTolerance: 2.0,

  // Used only when weightMode === 'api'.
  llmProvider: 'gemini',             // 'anthropic' | 'gemini' | 'openai'
  llmApiKey: '',
  llmModel: '',                      // blank => provider default chosen in worker

  // On no-confident category match: user chose leave-blank + flag (2026-06-09).
  categoryOnNoMatch: 'flag-blank',   // 'flag-blank' | 'closest'

  // Use the LLM (same channel as weightMode: web UI or API) to pick the category
  // from the dashboard's actual option list. Far more accurate than keyword
  // overlap (e.g. a novel titled "...Secret Baby..." must NOT map to Apparel-Baby).
  // Falls back to the heuristic only if no LLM channel is available.
  useLlmCategory: true,

  // DOM-only writes (user decision 2026-06-09: no backend access). Kept as a
  // flag so a future per-row write API can be slotted in without a refactor.
  useWriteApi: false,

  // On "Move Fail": if the India price (₹ ÷ this rate) is LOWER than the USA
  // price ($) — i.e. unprofitable — search amazon.com for the same product at a
  // cheaper USD (below the India price), update the USA + Source links, re-scrape
  // and let the dashboard re-decide. Rate = INR per USD.
  usdToInrRate: 95,

  // amazon.com keeps reverting to "Deliver to India" (India IP) and showing ₹,
  // which we won't write into USD. When INR is detected on .com, the extension
  // sets this US delivery ZIP once per run so .com renders real USD.
  usZip: '10001',
};

// Page-type classification strings shared in messages.
export const PAGE = {
  PRODUCT:    'product',
  NOT_FOUND:  'not_found',
  UNAVAILABLE:'unavailable',
  CAPTCHA:    'captcha',
  OTHER:      'other',
};

export async function getSettings() {
  const data = await chrome.storage.local.get([K.SETTINGS]);
  return { ...DEFAULT_SETTINGS, ...(data[K.SETTINGS] || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [K.SETTINGS]: next });
  return next;
}

// Normalise any user-entered origin to scheme://host[:port], stripping trailing
// path/slash so registerContentScripts gets a clean `${origin}/*` pattern.
export function normalizeOrigin(raw) {
  try {
    const u = new URL(String(raw).trim());
    return u.origin;
  } catch {
    // Fall back: strip path manually if it parses loosely.
    return String(raw || '').trim().replace(/\/+$/, '');
  }
}
