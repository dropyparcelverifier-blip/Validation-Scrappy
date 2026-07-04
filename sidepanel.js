// sidepanel.js — control + observability UI for the Dropy Auto-Validator.
// Phase 0: drives SCAN + Amazon probe, edits settings, renders the live log.

const $ = id => document.getElementById(id);
const send = msg => new Promise(res => chrome.runtime.sendMessage(msg, res));
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtTime = ts => new Date(ts).toLocaleTimeString();

let lastScanJson = '';

// ---------------- tabs ----------------
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
  });
});

// ---------------- state render ----------------
function renderState(s) {
  if (!s || !s.ok) return;
  const badge = $('statusBadge');
  badge.textContent = (s.status || 'Idle').replace(/\s*\(.*\)/, '').slice(0, 22);
  badge.title = s.status || 'Idle';
  badge.className = 'pill' + (s.pausedByCaptcha ? ' captcha' : s.running ? ' run' : (s.paused ? ' paused' : ''));
  $('curStatus').textContent = s.status || 'Idle';
  uiState = { running: !!s.running, paused: !!s.paused, pausedByCaptcha: !!s.pausedByCaptcha };
  renderControls();
  if (s.currentAsin !== undefined) $('curAsin').textContent = s.currentAsin || '—';
  if (s.step !== undefined) $('curStep').textContent = s.step || '—';
  if (s.page !== undefined) $('curPage').textContent = s.page ? `${s.page}${s.totalPages ? ' / ' + s.totalPages : ''}` : '—';
  // progress bar: processed of (processed + remaining on this page)
  const done = s.processedCount ?? (s.counters && s.counters.processed) ?? 0;
  const rem = s.queueRemaining ?? 0;
  const pct = (done + rem) > 0 ? Math.round((done / (done + rem)) * 100) : (s.running ? 5 : 0);
  const pf = $('pfill'); if (pf) pf.style.width = pct + '%';
  $('captchaBanner').style.display = s.pausedByCaptcha ? 'block' : 'none';
  $('regOrigin').textContent = s.registeredOrigin ? `dashboard CS: ${s.registeredOrigin}/*` : 'dashboard CS: not registered';

  const c = s.counters || {};
  $('cProcessed').textContent = s.processedCount ?? c.processed ?? 0;
  $('cPassed').textContent = c.passed || 0;
  $('cFailed').textContent = c.failed || 0;
  $('cLinkNf').textContent = c.linkNf || 0;
  $('cUsaLinkNf').textContent = c.usaLinkNf || 0;
  $('cFlagged').textContent = c.flagged || 0;

  if (s.settings) fillSettings(s.settings);
  if (Array.isArray(s.log)) { $('log').innerHTML = ''; s.log.forEach(appendLog); renderLiveInitial(s.log); }
}

function fillSettings(st) {
  $('setOrigin').value = st.dashboardOrigin || '';
  $('setBsr').value = st.bsrThreshold ?? 50000;
  $('setTimeout').value = st.pageTimeoutMs ?? 30000;
  $('setThrMin').value = st.throttleMinMs ?? 4000;
  $('setThrMax').value = st.throttleMaxMs ?? 9000;
  $('setUsZip').value = st.usZip ?? '10001';
  $('setRate').value = st.usdToInrRate ?? 95;
  $('setShowTab').checked = st.showWorkingTab !== false;
  $('setCatMode').value = st.categoryOnNoMatch || 'flag-blank';
  $('setUseLlmCat').checked = st.useLlmCategory !== false;
  $('setWeightMode').value = st.weightMode || 'gemini-web';
  $('setLlmProvider').value = st.llmProvider || 'gemini';
  $('setLlmModel').value = st.llmModel || '';
  $('setLlmKey').value = st.llmApiKey || '';
  $('dryRun').checked = !!st.dryRun;
  $('dryBadge').style.display = st.dryRun ? 'inline-block' : 'none';
  toggleApiFields();
}

function toggleApiFields() {
  const apiMode = $('setWeightMode').value === 'api';
  $('apiFields').style.opacity = apiMode ? '1' : '0.45';
}
$('setWeightMode')?.addEventListener('change', toggleApiFields);

// ---------------- log ----------------
function appendLog(line) {
  const div = document.createElement('div');
  div.className = 'logline';
  const kind = line.kind || '';
  div.innerHTML = `<span class="t">${fmtTime(line.ts)}</span><span class="${esc(kind)}">${esc(line.text)}</span>`;
  const log = $('log');
  log.appendChild(div);
  // keep last ~500 nodes
  while (log.childNodes.length > 500) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ---- Live log (Run tab) with a typewriter animation on the newest line ----
let typeTimer = null, typeEl = null;
function finishTyping() {
  if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
  if (typeEl) { const t = typeEl.querySelector('.txt'); if (t) t.textContent = typeEl._full; typeEl.querySelector('.cursor')?.remove(); typeEl = null; }
}
function liveAppend(line, animate = true) {
  const box = $('liveLog'); if (!box) return;
  finishTyping();                                   // complete any in-progress line instantly
  [...box.children].forEach(c => c.classList.remove('new'));
  const div = document.createElement('div');
  div.className = 'll new';
  div._full = String(line.text || '');
  div.innerHTML = `<span class="tt">${fmtTime(line.ts)}</span><span class="txt ${esc(line.kind || '')}"></span>`;
  box.appendChild(div);
  while (box.childNodes.length > 40) box.removeChild(box.firstChild);
  const txt = div.querySelector('.txt');
  if (!animate) { txt.textContent = div._full; box.scrollTop = box.scrollHeight; return; }
  const cur = document.createElement('span'); cur.className = 'cursor'; div.appendChild(cur);
  const full = div._full; const step = Math.max(1, Math.ceil(full.length / 40)); let i = 0;
  typeEl = div;
  typeTimer = setInterval(() => {
    i += step; txt.textContent = full.slice(0, i); box.scrollTop = box.scrollHeight;
    if (i >= full.length) finishTyping();
  }, 18);
}
function renderLiveInitial(lines) {
  const box = $('liveLog'); if (!box) return;
  finishTyping(); box.innerHTML = '';
  (lines || []).slice(-14).forEach(l => liveAppend(l, false));   // no animation on bulk load
}

// ---------------- scan render ----------------
function renderScan(scan) {
  lastScanJson = JSON.stringify(scan, null, 2);
  const out = $('scanOut');
  if (!scan) { out.innerHTML = '<p class="hint">No scan yet.</p>'; return; }
  let h = '';

  h += `<div class="card"><h3>Page</h3><div class="kv">
    <div>URL</div><div>${esc(scan.url)}</div>
    <div>Grid</div><div>${scan.grid ? `${esc(scan.grid.kind)} — ${scan.grid.rowCount} rows (${esc(scan.grid.selector)})` : '<span class="err">none detected</span>'}</div>
  </div></div>`;

  if (scan.notes?.length) h += `<div class="card" style="border-color:var(--warn)"><h3>Notes</h3>${scan.notes.map(n => `<div class="warn">• ${esc(n)}</div>`).join('')}</div>`;

  if (scan.headers?.length) {
    h += `<div class="card"><h3>Headers (${scan.headers.length})</h3><div>` +
      scan.headers.map(x => `<span class="pill">${x.index}: ${esc(x.text)}</span>`).join('') + `</div>`;
    const g = scan.columnGuesses || {};
    if (Object.keys(g).length) {
      h += `<h3 style="margin-top:8px">Column guesses</h3><div class="kv">` +
        Object.entries(g).map(([k, v]) => `<div>${esc(k)}</div><div>col ${v.index} — “${esc(v.header)}”</div>`).join('') + `</div>`;
    }
    h += `</div>`;
  }

  if (scan.rows?.length) {
    h += `<div class="card"><h3>Sample rows (${scan.rows.length})</h3>`;
    scan.rows.forEach(r => {
      h += `<div style="margin-bottom:8px;border-bottom:1px solid var(--line);padding-bottom:6px">
        <div class="kv">
          <div>ASIN</div><div>${esc(r.asin) || '<span class="err">not found</span>'}</div>
          <div>India URL</div><div>${esc(r.indiaUrl) || '—'}</div>
          <div>USA URL</div><div>${esc(r.usaUrl) || '—'}</div>
          <div>Checkbox</div><div>${r.hasCheckbox ? 'yes' : 'no'}</div>
        </div>
        <div style="margin-top:4px">${(r.cells || []).map(c => {
          const tag = [];
          if (c.inputs?.length) tag.push(`${c.inputs.length} input${c.inputs.some(i=>i.editable)?'*':''}`);
          if (c.buttons?.length) tag.push(`btn:${c.buttons.join('/')}`);
          if (c.checkbox) tag.push('☑');
          if (c.links?.length) tag.push(`${c.links.length}🔗`);
          return `<span class="pill" title="${esc(c.text)}">${c.index}${tag.length?': '+esc(tag.join(' ')):''}</span>`;
        }).join('')}</div>
      </div>`;
    });
    h += `</div>`;
  }

  if (scan.buttons?.length) {
    const hot = scan.buttons.filter(b => b.interesting);
    h += `<div class="card"><h3>Buttons (${scan.buttons.length}, ${hot.length} relevant)</h3><div>` +
      scan.buttons.map(b => `<span class="pill ${b.interesting ? 'hot' : ''}" ${b.disabled ? 'style="opacity:.5"' : ''}>${esc(b.label)}${b.disabled ? ' (disabled)' : ''}</span>`).join('') + `</div></div>`;
  }

  if (scan.selects?.length) {
    h += `<div class="card"><h3>Native &lt;select&gt; (${scan.selects.length})</h3>` +
      scan.selects.map(s => `<div><b>${esc(s.nearbyHeader || s.ariaLabel || s.name || 'select')}</b>: ${s.options.map(o => `<span class="pill">${esc(o)}</span>`).join('')}</div>`).join('') + `</div>`;
  }
  if (scan.customDropdowns?.length) {
    h += `<div class="card"><h3>Custom dropdowns (${scan.customDropdowns.length})</h3>` +
      scan.customDropdowns.map(d => `<span class="pill">${esc(d.nearbyHeader || d.text)} [${esc(d.role)}]</span>`).join('') + `</div>`;
  }
  if (scan.tabs?.length) h += `<div class="card"><h3>Status tabs</h3>${scan.tabs.map(t => `<span class="pill ${t.active?'hot':''}">${esc(t.text)}</span>`).join('')}</div>`;
  if (scan.toggles?.length) h += `<div class="card"><h3>ALL/RS/DP toggle</h3>${scan.toggles.map(t => `<span class="pill ${t.active?'hot':''}">${esc(t.text)}</span>`).join('')}</div>`;

  if (scan.pagination) {
    const p = scan.pagination;
    h += `<div class="card"><h3>Pagination</h3><div class="kv">
      <div>Text</div><div>${esc(p.text) || '—'}</div>
      <div>Page / total</div><div>${p.page ?? '?'} / ${p.totalPages ?? '?'}</div>
      <div>Next button</div><div>${p.hasNextButton ? (p.nextDisabled ? 'present (disabled)' : 'present') : 'not found'}</div>
    </div></div>`;
  }

  if (scan.rawSnippets && Object.keys(scan.rawSnippets).length) {
    h += `<div class="card"><h3>Raw HTML snippets (paste these back to lock selectors)</h3>`;
    for (const [k, v] of Object.entries(scan.rawSnippets)) {
      h += `<div class="muted" style="margin-top:6px">${esc(k)}</div><pre class="snip">${esc(v)}</pre>`;
    }
    h += `</div>`;
  }

  out.innerHTML = h;
}

// ---------------- actions ----------------
$('btnScan').addEventListener('click', async () => {
  $('scanOut').innerHTML = '<p class="hint">Scanning…</p>';
  const res = await send({ action: 'runScan' });
  if (res?.ok) renderScan(res.scan);
  else $('scanOut').innerHTML = `<p class="err">${esc(res?.error || 'scan failed')}</p>`;
});

$('btnProbe').addEventListener('click', async () => {
  const res = await send({ action: 'probeAmazonTab' });
  const out = $('scanOut');
  if (res?.ok) {
    out.innerHTML = `<div class="card"><h3>Amazon probe</h3><div class="kv">
      <div>URL</div><div>${esc(res.url)}</div>
      <div>Page type</div><div><b>${esc(res.result?.pageType || res.result?.error || 'no response')}</b></div>
    </div><p class="hint">Tip: open a real product page and a 404/“dog” page to confirm both classify correctly.</p></div>`;
  } else {
    out.innerHTML = `<p class="err">${esc(res?.error || 'probe failed')}</p><p class="hint">Make the Amazon tab the active tab, then probe.</p>`;
  }
});

$('btnCopyScan').addEventListener('click', async () => {
  if (!lastScanJson) return;
  try { await navigator.clipboard.writeText(lastScanJson); $('btnCopyScan').textContent = 'Copied!'; setTimeout(() => $('btnCopyScan').textContent = 'Copy JSON', 1200); } catch {}
});

$('btnSaveSettings').addEventListener('click', async () => {
  const patch = {
    dashboardOrigin: $('setOrigin').value.trim(),
    bsrThreshold: parseInt($('setBsr').value, 10) || 50000,
    pageTimeoutMs: parseInt($('setTimeout').value, 10) || 30000,
    throttleMinMs: parseInt($('setThrMin').value, 10) || 4000,
    throttleMaxMs: parseInt($('setThrMax').value, 10) || 9000,
    usZip: ($('setUsZip').value || '10001').trim(),
    usdToInrRate: parseFloat($('setRate').value) || 95,
    showWorkingTab: $('setShowTab').checked,
    categoryOnNoMatch: $('setCatMode').value,
    useLlmCategory: $('setUseLlmCat').checked,
    weightMode: $('setWeightMode').value,
    llmProvider: $('setLlmProvider').value,
    llmModel: $('setLlmModel').value.trim(),
    llmApiKey: $('setLlmKey').value,
    dryRun: $('dryRun').checked,
  };
  const res = await send({ action: 'saveSettings', patch });
  $('saveMsg').textContent = res?.ok ? 'Saved.' : ('Error: ' + (res?.error || ''));
  if (res?.ok) fillSettings(res.settings);
  setTimeout(() => $('saveMsg').textContent = '', 2000);
});

$('dryRun').addEventListener('change', () => {
  $('dryBadge').style.display = $('dryRun').checked ? 'inline-block' : 'none';
  send({ action: 'saveSettings', patch: { dryRun: $('dryRun').checked } });
});

$('btnClearLog').addEventListener('click', () => { send({ action: 'clearLog' }); $('log').innerHTML = ''; const lv = $('liveLog'); if (lv) lv.innerHTML = ''; });

// Engine controls.
let uiState = { running: false, paused: false, pausedByCaptcha: false };
function renderControls() {
  const { running, paused, pausedByCaptcha } = uiState;
  const startBtn = $('btnStart'), pauseBtn = $('btnPause'), stopBtn = $('btnStop');
  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running && !paused && !pausedByCaptcha;
  if (pauseBtn) {
    if (paused || pausedByCaptcha) { pauseBtn.textContent = 'Resume'; pauseBtn.dataset.act = 'resumeRun'; pauseBtn.disabled = false; }
    else if (running) { pauseBtn.textContent = 'Pause'; pauseBtn.dataset.act = 'pauseRun'; pauseBtn.disabled = false; }
    else { pauseBtn.textContent = 'Pause'; pauseBtn.dataset.act = 'pauseRun'; pauseBtn.disabled = true; }
  }
}
async function ctrl(action) {
  const res = await send({ action });
  if (!res?.ok) appendLog({ ts: Date.now(), text: res?.error || 'not available', kind: 'info' });
}
$('btnStart')?.addEventListener('click', () => ctrl('startRun'));
$('btnStop')?.addEventListener('click', () => ctrl('stopRun'));
$('btnPause')?.addEventListener('click', () => ctrl($('btnPause').dataset.act || 'pauseRun'));
$('btnResume')?.addEventListener('click', () => ctrl('resumeRun'));

// ---------------- export / reset ----------------
async function exportAudit(format) {
  const res = await send({ action: 'exportAudit', format });
  if (!res?.ok) { appendLog({ ts: Date.now(), text: 'export failed: ' + (res?.error || ''), kind: 'err' }); return; }
  if (!res.count) { appendLog({ ts: Date.now(), text: 'nothing to export yet', kind: 'info' }); return; }
  const a = document.createElement('a');
  a.href = res.dataUrl; a.download = res.filename;
  document.body.appendChild(a); a.click(); a.remove();
  appendLog({ ts: Date.now(), text: `exported ${res.count} rows → ${res.filename}`, kind: 'ok' });
}
$('btnExportCsv').addEventListener('click', () => exportAudit('csv'));
$('btnExportJson').addEventListener('click', () => exportAudit('json'));
$('btnCloseTabs')?.addEventListener('click', async () => {
  const btn = $('btnCloseTabs'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Closing…';
  const res = await send({ action: 'closeTabs' });
  appendLog({ ts: Date.now(), text: res?.ok ? 'stopped run + closed Amazon/LLM tabs' : 'close tabs failed', kind: res?.ok ? 'ok' : 'err' });
  renderState(await send({ action: 'getState' }));
  btn.disabled = false; btn.textContent = orig;
});
$('btnReset').addEventListener('click', async () => {
  // No blocking confirm() — it can be unreliable in the side panel and made
  // Reset look "broken". Reset only clears the extension's progress/log; the
  // dashboard rows are untouched.
  const btn = $('btnReset'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Resetting…';
  appendLog({ ts: Date.now(), text: 'reset requested — stopping run + clearing…', kind: 'info' });
  const res = await send({ action: 'resetRun' });
  appendLog({ ts: Date.now(), text: res?.ok ? 'progress + log reset' : ('reset failed: ' + (res?.error || '')), kind: res?.ok ? 'ok' : 'err' });
  renderState(await send({ action: 'getState' }));
  btn.disabled = false; btn.textContent = orig;
});

// ---------------- live updates ----------------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === 'log' && msg.line) { appendLog(msg.line); liveAppend(msg.line); }
  if (msg?.action === 'logCleared') { $('log').innerHTML = ''; const lv = $('liveLog'); if (lv) lv.innerHTML = ''; }
  if (msg?.action === 'progress' && msg.payload) renderState({ ok: true, ...msg.payload });
});

// ---------------- init ----------------
(async () => {
  const s = await send({ action: 'getState' });
  renderState(s);
  const ls = await send({ action: 'getLastScan' });
  if (ls?.scan) renderScan(ls.scan);
})();
