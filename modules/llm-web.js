// modules/llm-web.js — drive the ChatGPT / Gemini WEB UI in the user's
// logged-in session for the weight fallback (no API key needed).
//
// Keeps one persistent chat tab (created in the background). The user must be
// signed in to the site; if a login wall blocks readiness we surface a clear
// message and the engine flags the weight instead of guessing.

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITES = {
  'gemini-web':  'https://gemini.google.com/app?hl=en-IN',
  'chatgpt-web': 'https://chatgpt.com/',
};

let tabId = null;
let preferredWindowId = null;
// Create the LLM tab in the dashboard's window too (see amazon-tab.setWindow).
export function setWindow(id) { preferredWindowId = (typeof id === 'number') ? id : null; }

export function isWebMode(mode) { return mode === 'gemini-web' || mode === 'chatgpt-web'; }

export async function askWeb(mode, prompt, { timeoutMs = 120000, bringToFrontOnLogin = true, show = false } = {}) {
  const url = SITES[mode];
  if (!url) throw new Error('unknown web LLM mode: ' + mode);
  const id = await ensure(url, timeoutMs, bringToFrontOnLogin);
  // Show the LLM tab as the "working tab" while it answers.
  if (show) { try { const t = await chrome.tabs.get(id); await chrome.tabs.update(id, { active: true }); if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }); } catch {} }
  const res = await chrome.tabs.sendMessage(id, { type: 'LLM_ASK', prompt, timeoutMs });
  if (!res?.ok) throw new Error(res?.error || 'LLM_ASK failed');
  return res.text;
}

export async function closeTab() {
  if (tabId == null) return;
  try { await chrome.tabs.remove(tabId); } catch {}
  tabId = null;
}

async function ensure(url, timeoutMs, bringToFrontOnLogin) {
  const wantHost = new URL(url).host;

  // Reuse the existing tab if it's already on the site and ready.
  if (tabId != null) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.url && new URL(t.url).host === wantHost) {
        try { const p = await chrome.tabs.sendMessage(tabId, { type: 'LLM_PING' }); if (p?.ok && p.ready) return tabId; } catch {}
      }
    } catch { tabId = null; }
  }

  if (tabId == null) {
    const opts = { url, active: false };
    if (preferredWindowId != null) opts.windowId = preferredWindowId;
    let t;
    try { t = await chrome.tabs.create(opts); }
    catch { t = await chrome.tabs.create({ url, active: false }); }   // window gone → default
    tabId = t.id;
  } else { await chrome.tabs.update(tabId, { url }); }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let t; try { t = await chrome.tabs.get(tabId); } catch { tabId = null; throw new Error('LLM tab closed'); }
    if (t.status === 'complete') break;
    await sleep(300);
  }
  let warnedLogin = false;
  const signinDeadline = Date.now() + 15000;   // fail FAST if it's a sign-in wall
  while (Date.now() < deadline) {
    try {
      const p = await chrome.tabs.sendMessage(tabId, { type: 'LLM_PING' });
      if (p?.ok && p.ready) return tabId;
      if (p?.ok && p.signedIn === false) {
        if (bringToFrontOnLogin && !warnedLogin) {
          warnedLogin = true;
          try { const t = await chrome.tabs.get(tabId); await chrome.tabs.update(tabId, { active: true }); if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }); } catch {}
        }
        if (Date.now() > signinDeadline) throw new Error(`${wantHost}: NOT SIGNED IN — sign in (tab opened for you), or use API mode / turn off LLM category`);
      }
    } catch (e) { if (/NOT SIGNED IN/.test(e.message)) throw e; }
    await sleep(700);
  }
  throw new Error(`${wantHost} not ready — make sure you are logged in (the tab was opened for you)`);
}
