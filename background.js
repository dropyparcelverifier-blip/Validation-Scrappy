// background.js  (MV3 module service worker)
// Orchestrator for the Dropy Auto-Validator.
//
// Phase 0 scope (this file grows in later phases):
//   - Dynamically register the dashboard content script on the CONFIGURED origin
//     (origin is settable + changes over time, so it can't be a static manifest
//     content_script). Re-register whenever the origin setting changes.
//   - Route the SCAN command from the side panel to the dashboard tab and relay
//     the dump back to the panel.
//   - Persist settings, a log ring buffer, and run-state skeleton to
//     chrome.storage.local so the panel and (later) the engine survive SW
//     eviction / browser restart.
//
// The §1 state machine, queue, Amazon-tab management, dedupe and throttle land
// in Phases 1-5. The state shape + storage keys are laid out now so those phases
// slot in without reshuffling.

import {
  K, LOG_MAX, DEFAULT_SETTINGS, getSettings, setSettings, normalizeOrigin,
} from './config.js';
import { createEngine } from './modules/engine.js';

// ----------------------------------------------------------------------------
// In-memory state (rehydrated from storage on cold start).
// ----------------------------------------------------------------------------
const state = {
  settings: { ...DEFAULT_SETTINGS },
  running: false,
  paused: false,
  pausedByCaptcha: false,
  status: 'Idle',
  log: [],                    // [{ ts, text, kind, asin? }]
  processed: [],              // ASINs done (dedupe + resume)
  counters: { passed: 0, linkNf: 0, usaLinkNf: 0, flagged: 0, processed: 0 },
  registeredOrigin: null,     // origin the dashboard script is currently registered for
};

const DASHBOARD_SCRIPT_ID = 'dav-dashboard-cs';

// Side-panel opens on toolbar-icon click and stays open across tab switches —
// the right behaviour for a long unattended run the user walks away from.
try {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
} catch {}

// ----------------------------------------------------------------------------
// Cold start — hydrate state before answering any panel query, so a freshly
// woken SW never reports empty state and looks "closed".
// ----------------------------------------------------------------------------
const coldStart = (async () => {
  const data = await chrome.storage.local.get([
    K.SETTINGS, K.RUN_STATE, K.PROCESSED, K.LOG, K.COUNTERS,
  ]);
  state.settings = { ...DEFAULT_SETTINGS, ...(data[K.SETTINGS] || {}) };
  if (Array.isArray(data[K.PROCESSED])) state.processed = data[K.PROCESSED];
  if (Array.isArray(data[K.LOG]))       state.log = data[K.LOG];
  if (data[K.COUNTERS])                 state.counters = { ...state.counters, ...data[K.COUNTERS] };
  const rs = data[K.RUN_STATE] || {};
  state.status = rs.status || 'Idle';
  // Reflect paused/captcha for the panel immediately. If a run was in-flight when
  // the browser/SW died, autoResumeIfNeeded() (below) re-enters the loop once the
  // dashboard tab is back — the panel flips to "Running" then.
  state.paused = !!rs.paused;
  state.pausedByCaptcha = !!rs.pausedByCaptcha;

  await ensureDashboardRegistration(state.settings.dashboardOrigin);
})();

// ----------------------------------------------------------------------------
// Logging — ring buffer, debounced persistence, broadcast to the panel.
// ----------------------------------------------------------------------------
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

let logPersistTimer = null;
function pushLog(text, kind, asin) {
  if (!text) return;
  const line = { ts: Date.now(), text: String(text), kind: kind || null };
  if (asin) line.asin = asin;
  state.log.push(line);
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  if (logPersistTimer) clearTimeout(logPersistTimer);
  logPersistTimer = setTimeout(() => {
    chrome.storage.local.set({ [K.LOG]: state.log }).catch(() => {});
  }, 400);
  broadcast({ action: 'log', line });
}

// ----------------------------------------------------------------------------
// Dynamic content-script registration for the configurable dashboard origin.
// ----------------------------------------------------------------------------
async function ensureDashboardRegistration(rawOrigin) {
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return;
  if (state.registeredOrigin === origin) return;

  const pattern = `${origin}/*`;
  try {
    // Remove any prior registration (origin changed or stale from last load).
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DASHBOARD_SCRIPT_ID] });
      if (existing && existing.length) {
        await chrome.scripting.unregisterContentScripts({ ids: [DASHBOARD_SCRIPT_ID] });
      }
    } catch {}

    await chrome.scripting.registerContentScripts([{
      id: DASHBOARD_SCRIPT_ID,
      js: ['content/dashboard.js'],
      matches: [pattern],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
    state.registeredOrigin = origin;
    pushLog(`Dashboard content script registered for ${pattern}`, 'ok');

    // The dashboard tab may already be open from before registration — inject
    // now so the user doesn't have to reload it manually.
    await injectIntoOpenDashboardTabs(origin);
  } catch (e) {
    pushLog(`Failed to register dashboard script for ${pattern}: ${e.message}`, 'err');
  }
}

async function injectIntoOpenDashboardTabs(origin) {
  try {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/dashboard.js'] });
      } catch { /* already injected or restricted */ }
    }
  } catch {}
}

// Find the dashboard tab: prefer the active tab on the configured origin, else
// any tab on that origin.
async function getDashboardTab() {
  const origin = normalizeOrigin(state.settings.dashboardOrigin);
  if (!origin) return null;
  const onOrigin = await chrome.tabs.query({ url: `${origin}/*` });
  if (!onOrigin.length) return null;
  const active = onOrigin.find(t => t.active);
  return active || onOrigin[0];
}

// Send a message to the dashboard content script, ensuring it's injected first.
async function sendToDashboard(message) {
  const tab = await getDashboardTab();
  if (!tab?.id) {
    throw new Error('No dashboard tab open. Open the Validation dashboard, then retry.');
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    // Content script not present yet (registered after the tab loaded) — inject and retry once.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/dashboard.js'] });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (e2) {
      throw new Error(`Dashboard content script unreachable: ${e2.message}. Reload the dashboard tab.`);
    }
  }
}

// ----------------------------------------------------------------------------
// Run engine — the §1 state machine. Created once; controls routed below.
// ----------------------------------------------------------------------------
const engine = createEngine({
  log: (text, kind, asin) => pushLog(text, kind, asin),
  sendToDashboard: (m) => sendToDashboard(m),
  // Bring the dashboard tab to the foreground (so the "working tab" follows the
  // current phase — dashboard writes vs Amazon scraping vs LLM).
  focusDashboard: async () => {
    try { const t = await getDashboardTab(); if (t?.id) { await chrome.tabs.update(t.id, { active: true }); if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }); } } catch {}
  },
  // The dashboard's window — the engine creates the Amazon + LLM tabs here so all
  // the run's tabs live in ONE window (smooth "show working tab", no window jumps).
  getWorkingWindowId: async () => { try { const t = await getDashboardTab(); return (t && t.windowId != null) ? t.windowId : null; } catch { return null; } },
  emit: (payload) => {
    // Mirror engine progress into our state so getState stays accurate, then
    // broadcast to the panel for live updates.
    if (payload.counters) state.counters = payload.counters;
    if (payload.status) state.status = payload.status;
    state.running = payload.running;
    state.paused = payload.paused;
    state.pausedByCaptcha = payload.pausedByCaptcha;
    broadcast({ action: 'progress', payload });
  },
});

// ----------------------------------------------------------------------------
// Auto-resume — after a browser restart or an SW crash mid-run, continue the
// interrupted run automatically (the user chose unattended multi-PC operation).
// Only fires when the engine says a run was genuinely in-flight (not Stopped /
// Paused / Done). Waits for the dashboard tab to come back (session restore can
// lag several seconds on launch) before re-entering the loop.
// ----------------------------------------------------------------------------
let autoResumeDone = false;
async function autoResumeIfNeeded(trigger) {
  if (autoResumeDone) return;          // one attempt per SW lifetime
  autoResumeDone = true;
  try {
    await coldStart;
    await engine.hydrated;
    if (!engine.wantsResume()) return; // nothing interrupted to resume
    pushLog(`Auto-resume (${trigger}): a run was interrupted — waiting for the dashboard tab…`, 'info');
    let tab = null;
    for (let i = 0; i < 90; i++) {     // up to ~90s for session restore to reopen it
      tab = await getDashboardTab();
      if (tab?.id) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!tab?.id) {
      pushLog('Auto-resume aborted — no dashboard tab reopened. Open the dashboard and click Resume.', 'warn');
      return;
    }
    // Make sure the content script is registered/injected on the restored tab.
    await ensureDashboardRegistration(state.settings.dashboardOrigin);
    await new Promise(r => setTimeout(r, 1500));   // let the grid finish rendering
    if (!engine.wantsResume()) return;             // user already hit Resume during the wait
    const res = await engine.resume();
    pushLog(res?.ok ? 'Auto-resumed the interrupted run — skipping already-processed rows.'
                    : `Auto-resume failed: ${res?.error || 'unknown'} (click Resume to retry).`,
            res?.ok ? 'ok' : 'warn');
  } catch (e) {
    pushLog(`Auto-resume error: ${e.message} (click Resume to continue).`, 'warn');
  }
}
// Browser launch (PC restart) is the primary trigger; the cold-start call also
// covers an SW that was evicted mid-run and later re-woken.
try { chrome.runtime.onStartup?.addListener(() => autoResumeIfNeeded('browser start')); } catch {}
autoResumeIfNeeded('cold start');

// CSV export of the per-row audit records for the session.
function recordsToCsv(records) {
  const cols = ['asin', 'title', 'brand', 'funnel', 'bsr', 'weightGrams', 'weightSource', 'weightConfidence',
    'inr', 'usd', 'sourceLink', 'category', 'categoryConfident', 'branch', 'passed', 'dryRun', 'flags'];
  const esc = v => {
    if (v == null) v = '';
    if (Array.isArray(v)) v = v.join(' | ');
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const head = cols.join(',');
  const body = records.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
  return head + '\n' + body;
}

// ----------------------------------------------------------------------------
// Message router.
// ----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = msg?.action;

  // Snapshot of state for the panel to render on open / refresh.
  if (action === 'getState') {
    Promise.all([coldStart, engine.hydrated]).then(() => {
      const es = engine.getStatus();
      sendResponse({
        ok: true,
        settings: state.settings,
        running: es.running,
        paused: es.paused,
        pausedByCaptcha: es.pausedByCaptcha,
        status: es.status,
        currentAsin: es.currentAsin,
        step: es.step,
        page: es.page,
        totalPages: es.totalPages,
        log: state.log.slice(-LOG_MAX),
        counters: es.counters,
        processedCount: es.processedCount,
        registeredOrigin: state.registeredOrigin,
      });
    });
    return true;
  }

  if (action === 'saveSettings') {
    coldStart.then(async () => {
      const prevOrigin = normalizeOrigin(state.settings.dashboardOrigin);
      state.settings = await setSettings(msg.patch || {});
      const nextOrigin = normalizeOrigin(state.settings.dashboardOrigin);
      if (nextOrigin !== prevOrigin) {
        await ensureDashboardRegistration(nextOrigin);
      }
      sendResponse({ ok: true, settings: state.settings });
    });
    return true;
  }

  // Phase 0 — run a structural SCAN of the dashboard and relay the dump.
  if (action === 'runScan') {
    coldStart.then(async () => {
      try {
        pushLog('Running dashboard SCAN…', 'info');
        const dump = await sendToDashboard({ type: 'SCAN' });
        if (!dump?.ok) throw new Error(dump?.error || 'scan returned no data');
        await chrome.storage.local.set({ [K.LAST_SCAN]: dump.scan });
        pushLog(`SCAN complete: ${dump.scan?.headers?.length || 0} headers, ` +
                `${dump.scan?.buttons?.length || 0} buttons, ` +
                `${dump.scan?.rows?.length || 0} sample rows.`, 'ok');
        sendResponse({ ok: true, scan: dump.scan });
      } catch (e) {
        pushLog(`SCAN failed: ${e.message}`, 'err');
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  if (action === 'getLastScan') {
    chrome.storage.local.get([K.LAST_SCAN]).then(d => sendResponse({ ok: true, scan: d[K.LAST_SCAN] || null }));
    return true;
  }

  // Probe the Amazon content script on the active tab (sanity check for Phase 0).
  if (action === 'probeAmazonTab') {
    coldStart.then(async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('no active tab');
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'DETECT_PAGE_TYPE' });
        sendResponse({ ok: true, url: tab.url, result: res });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  if (action === 'clearLog') {
    state.log = [];
    chrome.storage.local.remove([K.LOG]).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // Content scripts (dashboard.js / amazon.js) forward step logs here.
  if (action === 'logFromContent') {
    pushLog(msg.text, msg.kind, msg.asin);
    sendResponse?.({ ok: true });
    return false;
  }

  // ----- Run-engine control -----
  if (action === 'startRun')  { coldStart.then(() => engine.start()).then(sendResponse);  return true; }
  if (action === 'pauseRun')  { sendResponse(engine.pause());  return false; }
  if (action === 'resumeRun') { coldStart.then(() => engine.resume()).then(sendResponse); return true; }
  if (action === 'stopRun')   { engine.stop().then(sendResponse); return true; }
  if (action === 'closeTabs') { engine.closeTabs().then(sendResponse); return true; }
  if (action === 'restartRun') {
    // Start over: full reset (stop + wipe progress/counters/records + log) then a
    // fresh Start from the top of the current page.
    coldStart.then(async () => {
      const r = await engine.reset();
      if (r?.ok) {
        state.log = [];
        await chrome.storage.local.remove([K.LOG]).catch(() => {});
        broadcast({ action: 'logCleared' });
      }
      return engine.start();
    }).then(sendResponse);
    return true;
  }
  if (action === 'resetRun')  {
    coldStart.then(() => engine.reset()).then(async (res) => {
      // Clear the activity log too — but only if the reset actually happened
      // (reset is refused while running).
      if (res?.ok) {
        state.log = [];
        await chrome.storage.local.remove([K.LOG]).catch(() => {});
        broadcast({ action: 'logCleared' });
      }
      sendResponse(res);
    });
    return true;
  }

  if (action === 'getRecords') {
    engine.hydrated.then(() => sendResponse({ ok: true, records: engine.getRecords() }));
    return true;
  }

  if (action === 'exportAudit') {
    engine.hydrated.then(() => {
      const records = engine.getRecords();
      const fmt = msg.format === 'json' ? 'json' : 'csv';
      const content = fmt === 'json' ? JSON.stringify(records, null, 2) : recordsToCsv(records);
      const mime = fmt === 'json' ? 'application/json' : 'text/csv';
      // Service workers can't use URL.createObjectURL; use a data URL.
      const dataUrl = `data:${mime};charset=utf-8,` + encodeURIComponent(content);
      sendResponse({ ok: true, dataUrl, filename: `dropy-audit-${Date.now()}.${fmt}`, count: records.length });
    });
    return true;
  }

  return false;
});

// Keep the dashboard registration fresh if settings are changed elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[K.SETTINGS]) return;
  const next = changes[K.SETTINGS].newValue;
  if (next?.dashboardOrigin) ensureDashboardRegistration(next.dashboardOrigin);
});

chrome.runtime.onInstalled?.addListener?.(() => { coldStart; });
chrome.runtime.onStartup?.addListener?.(() => { coldStart; });
