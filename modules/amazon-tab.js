// modules/amazon-tab.js — one managed Amazon tab, reused across the run.
//
// The engine opens ONE Amazon tab at a time (spec §2/§3.2). We keep a single
// reusable tab so we don't spawn dozens of tabs over a long run; it's created
// in the background (not focused) so it doesn't steal the user's attention,
// and brought to the foreground only when a CAPTCHA needs a human.

const sleep = ms => new Promise(r => setTimeout(r, ms));

let tabId = null;
let preferredWindowId = null;
// Create the managed tab in a SPECIFIC window (the dashboard's) so the run's
// tabs live alongside the dashboard — then "show working tab" is a smooth
// in-window tab switch instead of the OS jumping between separate windows.
export function setWindow(id) { preferredWindowId = (typeof id === 'number') ? id : null; }

export async function ensureTab() {
  if (tabId != null) {
    try { await chrome.tabs.get(tabId); return tabId; }
    catch { tabId = null; }
  }
  const opts = { url: 'about:blank', active: false };
  if (preferredWindowId != null) opts.windowId = preferredWindowId;
  let t;
  try { t = await chrome.tabs.create(opts); }
  catch { t = await chrome.tabs.create({ url: 'about:blank', active: false }); }  // window gone → default
  tabId = t.id;
  return tabId;
}

export function getTabId() { return tabId; }

export async function closeTab() {
  if (tabId == null) return;
  try { await chrome.tabs.remove(tabId); } catch {}
  tabId = null;
}

export async function bringToFront() {
  if (tabId == null) return;
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
  } catch {}
}

// Navigate the managed tab to `url`, wait for load + content-script readiness.
// Throws Error('page load timeout') if the page doesn't reach 'complete' and a
// pingable content script within timeoutMs.
export async function navigate(url, timeoutMs) {
  const id = await ensureTab();
  await chrome.tabs.update(id, { url });
  const deadline = Date.now() + timeoutMs;

  // 1) wait for the tab to reach 'complete'
  let complete = false;
  while (Date.now() < deadline) {
    let t;
    try { t = await chrome.tabs.get(id); } catch { throw new Error('amazon tab was closed'); }
    if (t.status === 'complete') { complete = true; break; }
    await sleep(300);
  }
  if (!complete) throw new Error('page load timeout');

  // 2) wait for the amazon content script to answer a ping
  while (Date.now() < deadline) {
    try {
      const res = await chrome.tabs.sendMessage(id, { type: 'AMAZON_PING' });
      if (res?.ok) return id;
    } catch { /* not injected yet */ }
    await sleep(300);
  }
  throw new Error('content script not ready');
}

// Send an RPC to the managed Amazon tab.
export async function rpc(message) {
  if (tabId == null) throw new Error('no amazon tab');
  return chrome.tabs.sendMessage(tabId, message);
}

// Search URL builder for the USA-NF branch.
export function searchUrl(origin, query) {
  return `${origin}/s?k=${encodeURIComponent(query)}`;
}
