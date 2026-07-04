// content/dashboard.js — injected on the CONFIGURED dashboard origin only
// (registered dynamically by the service worker; not a static manifest entry,
// because the origin is user-configurable and changes over time).
//
// Capabilities (all keyed by ASIN, resilient to framework re-renders; selected
// by visible header text / button label / position, NEVER by hashed classes):
//   SCAN               — structural dump (Phase 0) to confirm selectors.
//   READ_PAGE_ROWS     — array of {asin,title,brand,indiaUrl,usaUrl,funnel,rowIndex}.
//   WRITE_FIELD        — set Weight(G)/INR/USD/Source Link via React-aware setter.
//   SELECT_CATEGORY    — native <select> or custom dropdown.
//   SET_FUNNEL         — only if a writable control exists.
//   CLICK_PASS         — Pass button in the row's STATUS column.
//   CHECK_ROW          — tick the row checkbox (arms the toolbar NF buttons).
//   CLICK_LINK_NF / CLICK_USA_LINK_NF — toolbar buttons (enabled after a tick).
//   GOTO_NEXT_PAGE     — pagination Next.

(function () {
  if (window.__davDashboardReady) return;
  window.__davDashboardReady = true;

  const clip = (s, n) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n || 100000);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ASIN_RE = /\b(B0[A-Z0-9]{8})\b/;
  const DP_RE = /\/(?:dp|gp\/product|d|product)\/([A-Z0-9]{10})/i;

  function log(text, kind, asin) {
    try { chrome.runtime.sendMessage({ action: 'logFromContent', source: 'dashboard', text, kind, asin }).catch(() => {}); } catch {}
  }

  // React-aware value writer (see AdBrain amazon-reader). Setting `.value`
  // directly leaves a controlled input's framework state stale; the native
  // setter + input/change events make the framework register the change.
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ============================ grid detection ==============================
  function detectGrid() {
    let best = null;
    document.querySelectorAll('table').forEach(t => {
      const bodyRows = t.querySelectorAll('tbody tr, tr');
      if (!best || bodyRows.length > best.count) best = { el: t, count: bodyRows.length };
    });
    if (best && best.count >= 1) {
      const headEls = best.el.querySelectorAll('thead th, thead td');
      const headerEl = best.el.querySelector('thead tr') || best.el.querySelector('tr');
      const headers = (headEls.length ? Array.from(headEls) : Array.from(headerEl?.children || []))
        .map(c => ({ el: c, text: c.textContent || '' }));
      const bodyRows = Array.from(best.el.querySelectorAll('tbody tr'));
      const rows = (bodyRows.length ? bodyRows : Array.from(best.el.querySelectorAll('tr')).slice(1))
        .map(r => ({ el: r, cells: Array.from(r.children) }));
      return { kind: 'table', el: best.el, headerEl, headers, rows, describe: 'table (most rows)' };
    }
    const ariaGrid = document.querySelector('[role="grid"], [role="table"]');
    if (ariaGrid) {
      const headerEl = ariaGrid.querySelector('[role="row"]');
      const headers = Array.from(ariaGrid.querySelectorAll('[role="columnheader"]')).map(c => ({ el: c, text: c.textContent || '' }));
      const rows = Array.from(ariaGrid.querySelectorAll('[role="row"]'))
        .filter(r => r.querySelector('[role="gridcell"], [role="cell"]'))
        .map(r => ({ el: r, cells: Array.from(r.querySelectorAll('[role="gridcell"], [role="cell"]')) }));
      if (rows.length) return { kind: 'aria-grid', el: ariaGrid, headerEl, headers, rows, describe: '[role=grid|table]' };
    }
    let fbBest = null;
    document.querySelectorAll('div, ul, tbody').forEach(container => {
      const kids = Array.from(container.children);
      if (kids.length < 3) return;
      const rowish = kids.filter(k => DP_RE.test(k.innerHTML) || /amazon\.(in|com)/.test(k.innerHTML));
      if (rowish.length >= 3 && (!fbBest || rowish.length > fbBest.count)) fbBest = { el: container, count: rowish.length, rows: rowish };
    });
    if (fbBest) return {
      kind: 'div-grid(heuristic)', el: fbBest.el, headerEl: null, headers: [],
      rows: fbBest.rows.map(r => ({ el: r, cells: Array.from(r.children) })),
      describe: 'repeated-row container (heuristic)',
    };
    return null;
  }

  // header text -> logical field. Used by both SCAN and the read/write ops.
  const FIELD_RE = {
    asin:       /\basin\b/i,
    title:      /\b(title|product\s*name|description)\b/i,
    brand:      /\bbrand\b/i,
    indiaLink:  /\bindia\b/i,
    usaLink:    /\busa\b|\b\.com\b/i,
    funnel:     /\bfunnel\b/i,
    weight:     /\bweight\b/i,
    inr:        /₹|\binr\b|\brupee/i,
    usd:        /\$|\busd\b/i,
    sourceLink: /\bsource\b/i,
    category:   /\bcategory\b/i,
    status:     /\bstatus\b/i,
  };
  function guessColumns(headers) {
    const out = {};
    headers.forEach((h, i) => {
      const text = clip(h.text, 60);
      for (const [field, re] of Object.entries(FIELD_RE)) {
        if (out[field] === undefined && re.test(text)) out[field] = { index: i, header: text };
      }
    });
    return out;
  }

  // Locate a row object {el, cells} by ASIN. Re-detects the grid each call so
  // it survives React re-renders between operations.
  function findRow(asin) {
    const grid = detectGrid();
    if (!grid) return { grid: null, row: null };
    const wanted = String(asin || '').toUpperCase();
    for (const row of grid.rows) {
      const html = row.el.innerHTML;
      const dp = html.match(DP_RE);
      const rowAsin = ((dp && dp[1]) || (clip(row.el.textContent, 4000).match(ASIN_RE) || [])[1] || '').toUpperCase();
      if (rowAsin && rowAsin === wanted) return { grid, row };
      // fallback: ASIN appears as plain text in the row
      if (wanted && row.el.textContent && row.el.textContent.toUpperCase().includes(wanted)) return { grid, row };
    }
    return { grid, row: null };
  }

  function cellForField(grid, row, field) {
    const cols = guessColumns(grid.headers);
    const col = cols[field];
    if (!col) return null;
    return row.cells[col.index] || null;
  }

  // =============================== READ =====================================
  function readPageRows() {
    const grid = detectGrid();
    if (!grid) return { ok: false, error: 'no grid detected' };
    const cols = guessColumns(grid.headers);
    const out = [];
    grid.rows.forEach((row, rowIndex) => {
      const html = row.el.innerHTML;
      const dp = html.match(DP_RE);
      const asin = (dp && dp[1]) || (clip(row.el.textContent, 4000).match(ASIN_RE) || [])[1] || '';
      const links = Array.from(row.el.querySelectorAll('a[href]')).map(a => a.href);
      const cellText = (field) => {
        const c = cols[field] ? row.cells[cols[field].index] : null;
        return c ? clip(c.textContent, 200) : '';
      };
      out.push({
        rowIndex,
        asin,
        title: cellText('title'),
        brand: cellText('brand'),
        indiaUrl: links.find(u => /amazon\.in/.test(u)) || (cols.indiaLink ? (row.cells[cols.indiaLink.index]?.querySelector('a')?.href || '') : ''),
        usaUrl: links.find(u => /amazon\.com/.test(u)) || (cols.usaLink ? (row.cells[cols.usaLink.index]?.querySelector('a')?.href || '') : ''),
        funnel: cellText('funnel'),
        status: cellText('status'),
      });
    });
    return { ok: true, rows: out, columns: cols };
  }

  // =============================== WRITE ====================================
  async function writeField(asin, field, value) {
    const { grid, row } = findRow(asin);
    if (!grid) return { ok: false, error: 'no grid' };
    if (!row) return { ok: false, error: `row not found for ASIN ${asin}` };
    const cell = cellForField(grid, row, field);
    if (!cell) return { ok: false, error: `no column mapped for field "${field}" (headers: ${grid.headers.map(h => clip(h.text, 20)).join(', ')})` };

    let input = cell.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea');
    if (!input) {
      // Cell may need a click to reveal an inline editor.
      try { cell.click(); } catch {}
      await sleep(150);
      input = cell.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea');
    }
    if (input) {
      const prev = input.value;
      await typeIntoInput(input, String(value));
      await sleep(150);
      if (!valuesMatch(input.value, value)) { await typeIntoInput(input, String(value)); await sleep(150); }
      // FINAL settle check. The row can re-render during the waits above, which
      // DETACHES `input` from the DOM — its `.value` then lies (an orphan node
      // keeps the typed text while the visible cell shows the old/empty value).
      // So re-find the row+cell FRESH and read the committed value from there.
      await sleep(400);
      let now = String(input.value);
      const fresh = findRow(asin);
      const fcell = fresh.row ? cellForField(fresh.grid, fresh.row, field) : null;
      if (fcell) {
        const finp = fcell.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea');
        now = finp ? String(finp.value) : clip(fcell.textContent, 80);
        // Live input had detached/reverted → re-type into the fresh node once.
        if (finp && !valuesMatch(now, value)) { await typeIntoInput(finp, String(value)); await sleep(350); now = String(finp.value); }
      }
      const ok = valuesMatch(now, value);
      return {
        ok, via: 'input',
        error: ok ? undefined : `value did not stick (now="${clip(now, 40)}")`,
        prev, now,
        corrected: ok && prev && !valuesMatch(prev, value),
        cellHtml: ok ? undefined : clip((fcell || cell).outerHTML, 900),   // dump so the input can be locked
      };
    }
    // contenteditable cell?
    const ce = cell.querySelector('[contenteditable="true"]') || (cell.isContentEditable ? cell : null);
    if (ce) {
      ce.focus();
      ce.textContent = String(value);
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      ce.dispatchEvent(new Event('blur', { bubbles: true }));
      return { ok: true, via: 'contenteditable' };
    }
    return { ok: false, error: `no editable element in "${field}" cell — text="${clip(cell.textContent, 40)}"` };
  }

  // Compare a cell's CURRENT value to the value we tried to write. Numeric for
  // weight/price (ignores units/currency symbols, ±2%), substring-tolerant for
  // URLs/text. Used so a write is judged COMMITTED only when the live cell agrees.
  function valuesMatch(actual, intended) {
    const a = String(actual == null ? '' : actual).trim();
    const b = String(intended == null ? '' : intended).trim();
    if (!a) return false;
    if (a === b) return true;
    const numeric = /^[\d.,]+$/.test(b.replace(/[₹$\s]/g, ''));   // bare number (not a URL)
    if (numeric) {
      const na = parseFloat(a.replace(/[^0-9.]/g, '')), nb = parseFloat(b.replace(/[^0-9.]/g, ''));
      return Number.isFinite(na) && Number.isFinite(nb) && (Math.abs(na - nb) < 0.5 || (nb !== 0 && Math.abs(na - nb) / Math.abs(nb) < 0.02));
    }
    return a.includes(b) || b.includes(a);
  }

  function _setProp(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
  }
  // Type a value like a REAL user: focus → clear → key+InputEvent per character
  // (fires React onChange for every keystroke, so stubborn inputs like the
  // "Paste source link" url field actually commit) → change → Enter → blur/focusout.
  async function typeIntoInput(input, value) {
    value = String(value);
    input.focus(); try { input.click(); } catch {}
    // clear existing
    try { input.select && input.select(); } catch {}
    _setProp(input, '');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    // type each character
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      _setProp(input, value.slice(0, i + 1));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
    if (String(input.value) !== value) setNativeValue(input, value);  // safety
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    // Commit a blur the way React hears it (focusout bubbles; bare 'blur' doesn't).
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    try { input.blur(); } catch {}
  }

  // ============================== CATEGORY ==================================
  const _catOf = (cell) => {
    const sel = cell.querySelector('select');
    if (sel) { const t = clip(sel.options[sel.selectedIndex]?.textContent, 60); return /^\s*(select|choose|--)/i.test(t) ? '' : t; }
    const trig = cell.querySelector('[role="combobox"], [aria-haspopup="listbox"], button');
    const t = clip(trig?.textContent, 60); return /^\s*(select|choose|--)/i.test(t) ? '' : t;
  };
  async function selectCategory(asin, category) {
    const { grid, row } = findRow(asin);
    if (!row) return { ok: false, error: `row not found for ASIN ${asin}` };
    const cell = cellForField(grid, row, 'category') || row.el;
    const applied = () => norm(_catOf(cell)) === norm(category) || norm(_catOf(cell)).includes(norm(category));

    // 1) Native <select>.
    const sel = cell.querySelector('select');
    if (sel) {
      const opt = Array.from(sel.options).find(o => norm(o.textContent) === norm(category)) ||
                  Array.from(sel.options).find(o => norm(o.textContent).includes(norm(category)));
      if (!opt) return { ok: false, error: `category "${category}" not in select options` };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(sel, opt.value); else sel.value = opt.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      if (applied()) return { ok: true, via: 'select', chosen: clip(opt.textContent, 40) };
      // fall through to custom path if the native set didn't register
    }

    // 2) Custom dropdown: click trigger, then click the matching option.
    const trigger = cell.querySelector('[role="combobox"], [aria-haspopup="listbox"], button, [class*="select"]');
    if (trigger) {
      realClick(trigger);
      await sleep(350);
      const options = Array.from(document.querySelectorAll('[role="option"], li[role="option"], [role="menuitem"], li, [class*="option"]')).filter(isVisible);
      let match = options.find(o => norm(o.textContent) === norm(category)) || options.find(o => norm(o.textContent).includes(norm(category)));
      if (match) { realClick(match); await sleep(400); if (applied()) return { ok: true, via: 'custom-dropdown', chosen: clip(match.textContent, 40) }; }
      try { document.body.click(); } catch {}
    }
    return { ok: false, error: `category "${category}" did not apply (now="${_catOf(cell) || 'empty'}")`, cellHtml: clip(cell.outerHTML, 900) };
  }
  function norm(s) { return clip(s, 80).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  // List the category options + the CURRENTLY selected value (so the engine can
  // cross-verify a pre-filled category and only correct it when wrong).
  function getCategoryOptions(asin) {
    const { grid, row } = asin ? findRow(asin) : { grid: detectGrid(), row: null };
    const scope = (row && grid && cellForField(grid, row, 'category')) || document;
    const sel = scope.querySelector('select');
    if (sel) {
      const cur = clip(sel.options[sel.selectedIndex]?.textContent, 60);
      const isPlaceholder = /^\s*(select|choose|--)/i.test(cur);
      return { ok: true, kind: 'select', selected: isPlaceholder ? '' : cur, options: Array.from(sel.options).map(o => clip(o.textContent, 60)).filter(Boolean) };
    }
    // Custom: read the trigger's current text, then open to read options.
    const trigger = scope.querySelector('[role="combobox"], [aria-haspopup="listbox"], button, [class*="select"]');
    if (trigger) {
      const cur = clip(trigger.textContent, 60);
      const isPlaceholder = /^\s*(select|choose|--)/i.test(cur);
      trigger.click();
      const options = Array.from(document.querySelectorAll('[role="option"]')).map(o => clip(o.textContent, 60)).filter(Boolean);
      try { document.body.click(); } catch {}
      return { ok: true, kind: 'custom', selected: isPlaceholder ? '' : cur, options };
    }
    return { ok: false, error: 'no category control found', options: [], selected: '' };
  }

  // Edit the USA LINK cell (pencil → input → ✓). Used by the rescue flow to
  // point the row at a cheaper/available .com listing.
  async function setUsaLink(asin, url) {
    const { grid, row } = findRow(asin);
    if (!row) return { ok: false, error: `row not found for ASIN ${asin}` };
    const cell = cellForField(grid, row, 'usaLink');
    if (!cell) return { ok: false, error: 'no USA link column' };
    let input = cell.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea');
    if (!input) {
      // open edit mode — click the pencil (an edit button/icon, NOT the .com link)
      const edit = Array.from(cell.querySelectorAll('button, [role="button"], svg, [class*="edit"], [class*="pencil"], a'))
        .filter(e => isVisible(e) && !/\.com/i.test(clip(e.textContent, 20)))
        .map(e => e.closest('button') || e)[0];
      if (edit) { realClick(edit); await sleep(300); }
      input = cell.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea');
    }
    if (!input) return { ok: false, error: 'USA link edit input not found', cellHtml: clip(cell.outerHTML, 900) };
    await typeIntoInput(input, url);
    await sleep(150);
    // confirm — the green ✓ (or Enter)
    const confirm = cell.querySelector('button[aria-label*="save" i], button[aria-label*="confirm" i], button[title*="save" i]')
      || Array.from(cell.querySelectorAll('button, [role="button"]')).find(e => isVisible(e) && /check|save|confirm|✓|done/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.className || '') + ' ' + (e.textContent || '')));
    if (confirm) realClick(confirm);
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await sleep(400);
    return { ok: true };
  }

  // =============================== FUNNEL ===================================
  // Cross-verify and correct the funnel. Reads the current RS/DP badge; if it
  // already matches, no-op; otherwise tries select / RS-DP buttons / a toggle.
  const _funnelOf = (cell) => ((cell?.textContent || '').match(/\b(RS|DP)\b/i) || [])[1]?.toUpperCase() || '';
  async function setFunnel(asin, funnel) {
    funnel = String(funnel).toUpperCase();
    const { grid, row } = findRow(asin);
    if (!row) return { ok: false, error: `row not found for ASIN ${asin}` };
    const cell = cellForField(grid, row, 'funnel');
    if (!cell) return { ok: false, error: 'no funnel column' };
    const current = _funnelOf(cell);
    if (current === funnel) return { ok: true, current, changed: false };

    // The popover options are "Restock" (RS) / "Dropshipping" (DP). Match by the
    // FULL WORD only — NEVER by "RS"/"DP" codes, because the ALL/RS/DP grid
    // FILTER (outside the funnel column) has buttons literally labelled "RS"/"DP"
    // and we must not click those (that filters the grid and hides the row).
    const optRe = funnel === 'RS' ? /restock/i : /dropship/i;

    // 1) native <select> (if any)
    const sel = cell.querySelector('select');
    if (sel) {
      const opt = Array.from(sel.options).find(o => optRe.test(clip(o.textContent, 20)));
      if (opt) {
        sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(250);
        const now = _funnelOf(cell); return { ok: now === funnel, current, changed: now === funnel, via: 'select', cellHtml: now === funnel ? undefined : clip(cell.outerHTML, 800) };
      }
    }
    // 2) The dashboard control: <button title="Click to change funnel"> with a
    //    RS/DP span. Clicking it changes the value. RE-FIND the cell after each
    //    click — the row re-renders into a NEW node, so a held reference goes
    //    stale (that was the false "couldn't set").
    const pickOption = () => {
      // The menu shows "RS Restock" / "DP Dropshipping". Pick the SMALLEST
      // visible clickable element matching the desired funnel.
      const opts = Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], li, a, div, span'))
        .filter(o => isVisible(o) && optRe.test(clip(o.textContent, 40)) && (o.textContent || '').trim().length <= 40);
      opts.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      return opts[0] || null;
    };
    const menuDump = () => {
      // smallest visible element containing BOTH options = the open menu
      const m = Array.from(document.querySelectorAll('div, ul, [role="menu"], [role="listbox"]'))
        .filter(el => isVisible(el) && /restock/i.test(el.textContent || '') && /dropship/i.test(el.textContent || ''))
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
      return m ? clip(m.outerHTML, 900) : '';
    };
    let curCell = cell, menuHtml = '';
    for (let i = 0; i < 3 && _funnelOf(curCell) !== funnel; i++) {
      const fbtn = curCell.querySelector('button[title*="funnel" i]') || curCell.querySelector('button, [role="button"]');
      if (!fbtn) break;
      fbtn.click();                            // open the menu
      await sleep(500);
      menuHtml = menuDump();                    // capture the open menu (for debug)
      let opt = pickOption();
      if (!opt) { realClick(fbtn); await sleep(500); menuHtml = menuDump() || menuHtml; opt = pickOption(); }
      if (opt) {
        // click the option robustly, then check immediately + after a settle
        opt.click(); realClick(opt); await sleep(150);
        const fast = (findRow(asin).row && cellForField(findRow(asin).grid, findRow(asin).row, 'funnel'));
        await sleep(450);
      }
      const fr = findRow(asin); if (fr.row) curCell = cellForField(fr.grid, fr.row, 'funnel') || curCell;
    }
    const now = _funnelOf(curCell);
    return {
      ok: now === funnel, current, changed: now === funnel && now !== current, via: 'funnel-menu',
      cellHtml: now === funnel ? undefined : clip(curCell.outerHTML, 700),
      menuHtml: now === funnel ? undefined : menuHtml,
    };
  }

  // ============================ ROW ACTIONS =================================
  function rowButton(row, re) {
    return Array.from(row.el.querySelectorAll('button, [role="button"], a')).find(b => re.test(clip(b.textContent || b.getAttribute('aria-label'), 30)));
  }

  // Read the current values of a row's editable fields (to verify completeness).
  function readRowFields(grid, row) {
    const val = (f) => {
      const c = cellForField(grid, row, f);
      if (!c) return '';
      const inp = c.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea');
      if (inp) return String(inp.value || '').trim();
      const sel = c.querySelector('select');
      if (sel) { const t = clip(sel.options[sel.selectedIndex]?.textContent, 60); return /^\s*(select|choose|--)/i.test(t) ? '' : t; }
      return clip(c.textContent, 60);
    };
    const fcell = cellForField(grid, row, 'funnel');
    return { weight: val('weight'), inr: val('inr'), usd: val('usd'), sourceLink: val('sourceLink'), category: val('category'), funnel: fcell ? _funnelOf(fcell) : '' };
  }

  // "Move Pass" only renders once the row's required fields are all filled. So we
  // confirm completeness, give the UI a moment to render the button, then click
  // it. If a field is missing, we report WHICH — that's why Pass wasn't shown.
  async function clickPass(asin, opts) {
    let { grid, row } = findRow(asin);
    // The funnel toggle (just before) re-renders the row — retry the lookup.
    for (let i = 0; i < 4 && !row; i++) { await sleep(400); ({ grid, row } = findRow(asin)); }
    if (!row) return { ok: false, error: `row not found for ASIN ${asin}` };
    row.el.scrollIntoView({ block: 'center' });

    // The dashboard requires ALL of these (incl. INR) before it shows "Move
    // Pass". A valid .in product with no INR price can't be auto-passed — it's
    // flagged + left for manual review (user rule 2026-06-10).
    const required = (opts && opts.required) || ['weight', 'inr', 'usd', 'sourceLink', 'category'];
    const vals = readRowFields(grid, row);
    const missing = required.filter(f => !vals[f]);

    // 1) If "Move Pass" is already showing, click it DIRECTLY (no Tab). Poll/hover
    //    a few times since it may render once the row is hovered.
    let btn = findPassButton(row) || findVisibleMovePass();
    for (let i = 0; i < 8 && !btn; i++) {
      ({ grid, row } = findRow(asin)); if (!row) break;
      hoverEl(row.el);
      const sc = cellForField(grid, row, 'status'); if (sc) { hoverEl(sc); const inner = sc.querySelector('div, span') || sc; hoverEl(inner); }
      btn = findPassButton(row) || findVisibleMovePass() || findMovePassAnyVisibility(row);
      if (!btn) await sleep(250);
    }

    // BEFORE the Tab-5× reveal, CHECK FIELDS — there's no point revealing Move
    // Pass if the row is incomplete (it won't appear, and it shouldn't pass).
    if (!btn && missing.length) {
      return { ok: false, error: `Move Pass not shown — required field(s) empty: ${missing.join(', ')}`, missing, values: vals };
    }

    // 2) ONLY if it still isn't shown AND all fields are filled, use the
    //    Tab-from-Weight reveal as fallback.
    if (!btn) {
      const wInput = cellForField(grid, row, 'weight')?.querySelector('input, textarea, [contenteditable="true"]');
      if (wInput) { try { wInput.scrollIntoView({ block: 'center' }); wInput.focus(); wInput.click(); } catch {} }
      for (let i = 0; i < 6 && !btn; i++) {
        const ae = document.activeElement || wInput || document.body;
        tabKey(ae);          // Tab keydown/keyup (dashboard may render on this)
        focusNext();         // actually move focus one column right
        await sleep(200);
        ({ grid, row } = findRow(asin)); if (!row) break;
        hoverEl(row.el);
        const sc = cellForField(grid, row, 'status'); if (sc) hoverEl(sc);
        btn = findPassButton(row) || findVisibleMovePass() || findMovePassAnyVisibility(row);
      }
    }

    for (let i = 0; i < 16 && !btn; i++) {
      ({ grid, row } = findRow(asin)); if (!row) break;
      // Hover the row, the STATUS cell, and the actual element under the cell's
      // center point — "Move Pass" renders only while genuinely hovered.
      hoverEl(row.el);
      const statusCell = cellForField(grid, row, 'status') || row.cells[row.cells.length - 2];
      if (statusCell) {
        try { statusCell.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        hoverEl(statusCell);
        const inner = statusCell.querySelector('div, span') || statusCell;
        hoverEl(inner);
        try {
          const r = statusCell.getBoundingClientRect();
          const atPoint = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (atPoint) hoverEl(atPoint);
        } catch {}
        if (i === 4) { try { statusCell.click(); } catch {} }   // some grids reveal actions on cell click
      }
      btn = findPassButton(row) || findVisibleMovePass() || findMovePassAnyVisibility(row);
      if (!btn) await sleep(300);
    }

    if (!btn) {
      // Dump the STATUS, SOURCE LINK and CATEGORY cells so the controls can be
      // locked (Move Pass + the source-link/category persistence issue).
      let statusHtml = '', sourceHtml = '', categoryHtml = '';
      try {
        const fr = findRow(asin);
        if (fr.row) {
          const sc = cellForField(fr.grid, fr.row, 'status');
          const src = cellForField(fr.grid, fr.row, 'sourceLink');
          const cat = cellForField(fr.grid, fr.row, 'category');
          statusHtml = sc ? clip(sc.outerHTML, 900) : '';
          sourceHtml = src ? clip(src.outerHTML, 900) : '';
          categoryHtml = cat ? clip(cat.outerHTML, 700) : '';
        }
        try { console.log('[DAV] Pass not found for', asin, '\nSTATUS:\n', statusHtml, '\nSOURCE:\n', sourceHtml, '\nCATEGORY:\n', categoryHtml); } catch {}
      } catch {}
      const why = missing.length
        ? `Move Pass not shown — required field(s) empty: ${missing.join(', ')}`
        : 'Move Pass not shown (all fields look filled — selector may need locking)';
      return { ok: false, error: why, missing, values: vals, statusHtml, sourceHtml, categoryHtml };
    }

    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'verdict button is disabled' };
    const verdict = verdictOf(btn);   // 'pass' or 'fail' — the dashboard's call
    // If FAIL, try to capture the dashboard's reason (tooltip/title near the pill).
    let failReason = '';
    if (verdict === 'fail') {
      const fr = findRow(asin);
      const sc = fr.grid && fr.row ? cellForField(fr.grid, fr.row, 'status') : null;
      if (sc) failReason = clip(sc.getAttribute('title') || sc.querySelector('[title]')?.getAttribute('title') || (sc.textContent || '').replace(/move\s*fail/i, ''), 100);
    }
    // Peek mode: report the verdict WITHOUT clicking (so the engine can try a
    // rescue before a Fail is committed).
    if (opts && opts.peek) return { ok: true, verdict, failReason, peeked: true };
    realClick(btn);
    // If it opens a confirmation modal (like Link NF), confirm it.
    const confirm = await waitConfirmButton(/^move to (pass|fail)/i, 3500);
    if (confirm) { confirm.click(); await sleep(500); }
    return { ok: true, verdict, failReason, missing };
  }

  // Highlight the row currently being processed (visible marker for the user).
  let _davHi = null;
  function highlightRow(asin) {
    if (_davHi) { try { _davHi.style.outline = ''; _davHi.style.outlineOffset = ''; _davHi.style.boxShadow = ''; } catch {} _davHi = null; }
    if (!asin) return { ok: true, cleared: true };
    const { row } = findRow(asin);
    if (!row) return { ok: false, error: 'row not found' };
    try {
      row.el.style.outline = '3px solid #4f8cff';
      row.el.style.outlineOffset = '-3px';
      row.el.style.boxShadow = '0 0 0 3px rgba(79,140,255,.35)';
      row.el.scrollIntoView({ block: 'center' });
    } catch {}
    _davHi = row.el;
    return { ok: true };
  }

  function rowFocusables(row) {
    return Array.from(row.el.querySelectorAll('input:not([type="hidden"]),select,textarea,button,a[href],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'))
      .filter(isVisible);
  }
  // Full pointer+mouse event sequence so frameworks that ignore a bare .click() still fire.
  function realClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) {
      try {
        const Ctor = t.startsWith('pointer') ? PointerEvent : (t === 'focus' ? FocusEvent : MouseEvent);
        el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true }));
      } catch { try { el.dispatchEvent(new MouseEvent(t.replace('pointer', 'mouse'), { bubbles: true, cancelable: true })); } catch {} }
    }
    try { el.click(); } catch {}
  }

  // The STATUS cell shows the dashboard's VERDICT button — "Move Pass" (green)
  // OR "Move Fail" (red), depending on whether the row passes its rules. We
  // click whichever is present. (Strict "move pass/fail" so the PASS/FAIL pills
  // and the Pass/Failed File tabs never match.)
  const MOVE_RE = /^move\s*(pass|fail)$/i;
  function verdictOf(btn) { return /fail/i.test((btn && (btn.textContent || btn.getAttribute('aria-label'))) || '') ? 'fail' : 'pass'; }
  function findPassButton(row) {
    if (!row) return null;
    return Array.from(row.el.querySelectorAll('button, [role="button"], a'))
      .find(b => MOVE_RE.test(clip(b.textContent || b.getAttribute('aria-label'), 30)) && isVisible(b)) || null;
  }
  function findVisibleMovePass() {
    return Array.from(document.querySelectorAll('button, [role="button"], a'))
      .find(b => MOVE_RE.test(clip(b.textContent || b.getAttribute('aria-label'), 30)) && isVisible(b)) || null;
  }
  function isVisible(el) { return !!(el && el.offsetParent !== null); }
  // Hover an element using REAL coordinates at its center — needed so a
  // framework's onMouseEnter/onMouseOver actually fires and renders row actions.
  function hoverEl(el) {
    if (!el) return;
    let x = 10, y = 10;
    try { const r = el.getBoundingClientRect(); x = r.left + Math.min(r.width / 2, 40); y = r.top + r.height / 2; } catch {}
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      try {
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      } catch { try { el.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), { bubbles: true, clientX: x, clientY: y })); } catch {} }
    }
  }
  function hoverRow(el) { hoverEl(el); }
  // Wait for a visible confirmation-modal button (e.g. "Move to Link NF").
  async function waitConfirmButton(re, ms) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const b = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(x => re.test(clip(x.textContent || x.getAttribute('aria-label'), 40)) && isVisible(x));
      if (b) return b;
      await sleep(150);
    }
    return null;
  }
  // Uncheck every selected row checkbox (and select-all) so only the target row
  // gets ticked — the toolbar actions operate on ALL checked rows.
  function clearAllChecks() {
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.checked) { try { cb.click(); } catch {} if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); } }
    });
  }
  // Find a "Move Pass"/"Move Fail" element even if currently hidden — last resort.
  function findMovePassAnyVisibility(row) {
    const inRow = row && Array.from(row.el.querySelectorAll('button, [role="button"], a'))
      .find(b => MOVE_RE.test(clip(b.textContent || b.getAttribute('aria-label'), 30)));
    if (inRow) return inRow;
    return Array.from(document.querySelectorAll('button, [role="button"], a'))
      .find(b => MOVE_RE.test(clip(b.textContent || b.getAttribute('aria-label'), 30))) || null;
  }
  function tabKey(el) {
    const opts = { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }
  // Move DOM focus to the next focusable element (synthetic Tab doesn't move focus).
  function focusNext() {
    const f = Array.from(document.querySelectorAll('input:not([type="hidden"]),select,textarea,button,a[href],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'))
      .filter(e => e.offsetParent !== null || e === document.activeElement);
    const i = f.indexOf(document.activeElement);
    if (i >= 0 && i + 1 < f.length) f[i + 1].focus();
    else if (f.length) f[0].focus();
  }

  async function checkRow(asin) {
    const { row } = findRow(asin);
    if (!row) return { ok: false, error: `row not found for ASIN ${asin}` };
    // Clear any other selected rows first so the toolbar action affects ONLY
    // this row (the dashboard's NF actions move ALL checked rows).
    clearAllChecks();
    await sleep(120);
    // 1) real checkbox input
    let cb = row.el.querySelector('input[type="checkbox"]');
    if (cb) {
      if (!cb.checked) cb.click();
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('click', { bubbles: true })); cb.dispatchEvent(new Event('change', { bubbles: true })); }
      await sleep(100);
      return { ok: cb.checked, via: 'input', error: cb.checked ? undefined : 'checkbox did not become checked' };
    }
    // 2) ARIA checkbox
    const aria = row.el.querySelector('[role="checkbox"]');
    if (aria) {
      if (aria.getAttribute('aria-checked') !== 'true') aria.click();
      await sleep(100);
      return { ok: true, via: 'aria' };
    }
    // 3) custom styled checkbox — click the first cell's clickable element
    const firstCell = (row.cells && row.cells[0]) || row.el.firstElementChild;
    if (firstCell) {
      const target = firstCell.querySelector('span, div, label, button, svg') || firstCell;
      target.click();
      await sleep(100);
      return { ok: true, via: 'first-cell-click', note: 'clicked custom checkbox; verify selection visually' };
    }
    return { ok: false, error: 'no checkbox in row' };
  }

  // The ACTION toolbar holds "Move to Reworking / Link NF / USA Link NF / Move to
  // Reject / Roll Back". There are ALSO status TABS with the same "Link NF" /
  // "USA Link NF" text — we must NOT click those. Find the action bar (the
  // container with the action verbs) and pick the real action button inside it.
  function findActionBar() {
    let best = null;
    document.querySelectorAll('div, section, header, nav').forEach(c => {
      const t = c.textContent || '';
      let score = 0;
      ['Move to Reworking', 'Move to Reject', 'Roll Back', 'USA Link NF'].forEach(k => { if (t.includes(k)) score++; });
      if (score >= 2 && (!best || t.length < best.len)) best = { el: c, len: t.length };
    });
    return best?.el || null;
  }
  function findActionButton(re) {
    const scope = findActionBar() || document;
    const btns = Array.from(scope.querySelectorAll('button, [role="button"]'))
      .filter(el => el.getAttribute('role') !== 'tab' && !el.closest('[role="tablist"]'))
      .filter(el => re.test(clip(el.textContent || el.getAttribute('aria-label'), 30)));
    // Prefer the one with an icon (chain) — that's the toolbar action button.
    return btns.find(el => el.querySelector('svg, img, i, [class*="icon"]')) || btns.find(el => el.tagName === 'BUTTON') || btns[0] || null;
  }

  // Click an action-toolbar button, wait for it to enable after a row tick, then
  // CONFIRM the modal it opens ("Move to Link NF" / "Move to USA Link NF").
  async function clickToolbar(actionRe, confirmRe, label) {
    let btn = findActionButton(actionRe);
    if (!btn) return { ok: false, error: `action-toolbar "${label}" button not found (only the tab?)` };
    for (let i = 0; i < 10 && (btn.disabled || btn.getAttribute('aria-disabled') === 'true'); i++) {
      await sleep(150);
      btn = findActionButton(actionRe) || btn;
    }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: `"${label}" stayed disabled — row checkbox not registered` };
    }
    btn.click();
    // Confirm the modal ("Move X items to … Not Found?").
    const confirm = await waitConfirmButton(confirmRe, 6000);
    if (!confirm) return { ok: false, error: `confirm modal "${label}" button not found` };
    confirm.click();
    await sleep(600);
    return { ok: true, confirmed: true };
  }

  function gotoNextPage() {
    const btn = findButtonByText(/^next$/i) || findButtonByText(/^next\b/i) || findButtonByText(/›|»/);
    if (!btn) return { ok: false, error: 'Next button not found' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'Next disabled (last page?)', lastPage: true };
    btn.click();
    return { ok: true };
  }

  function gotoFirstPage() {
    const btn = findButtonByText(/^first$/i) || findButtonByText(/^first\b/i) || findButtonByText(/«|⟪/);
    if (!btn) {
      // already on page 1 (no First button needed)?
      const p = readPagination();
      if (p && p.page === 1) return { ok: true, alreadyFirst: true };
      return { ok: false, error: 'First button not found' };
    }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: true, alreadyFirst: true };
    btn.click();
    return { ok: true };
  }

  function readPagination() {
    const bodyText = document.body.innerText || '';
    const m = bodyText.match(/page\s+(\d+)\s+of\s+([\d,]+)/i);
    return m ? { text: m[0], page: parseInt(m[1], 10), totalPages: parseInt(m[2].replace(/,/g, ''), 10) } : null;
  }

  function findButtonByText(re) {
    const els = document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
    for (const el of els) {
      const t = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      if (re.test(t)) return el;
    }
    return null;
  }

  // ============================== SCAN ======================================
  function runScan() {
    const scan = { url: location.href, title: document.title, ts: Date.now(), grid: null, headers: [], columnGuesses: {}, rows: [], buttons: [], inputs: [], selects: [], customDropdowns: [], tabs: [], toggles: [], pagination: null, rawSnippets: {}, notes: [] };
    const grid = detectGrid();
    if (!grid) scan.notes.push('No grid/table detected — the list may be virtualized; scroll it into view and re-run SCAN.');
    else {
      scan.grid = { kind: grid.kind, rowCount: grid.rows.length, selector: grid.describe };
      scan.headers = grid.headers.map((h, i) => ({ index: i, text: clip(h.text, 60) }));
      scan.columnGuesses = guessColumns(grid.headers);
      scan.rows = grid.rows.slice(0, 3).map((row, ri) => describeRow(row, ri));
      if (grid.headerEl) scan.rawSnippets.headerRow = clip(grid.headerEl.outerHTML, 2500);
      if (grid.rows[0]?.el) scan.rawSnippets.firstDataRow = clip(grid.rows[0].el.outerHTML, 3500);
    }
    scan.buttons = scanButtons();
    scan.inputs = scanInputs();
    scan.selects = scanSelects();
    scan.customDropdowns = scanCustomDropdowns();
    scan.tabs = scanTabs();
    scan.toggles = scanToggles();
    scan.pagination = (() => {
      const p = readPagination();
      const nextBtn = findButtonByText(/^next$/i) || findButtonByText(/›|»/);
      if (!p && !nextBtn) return null;
      return { ...(p || {}), hasNextButton: !!nextBtn, nextDisabled: nextBtn ? !!(nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') : null };
    })();
    const toolbar = findToolbar();
    if (toolbar) scan.rawSnippets.toolbar = clip(toolbar.outerHTML, 3000);
    log(`SCAN: grid=${scan.grid ? scan.grid.kind : 'none'} headers=${scan.headers.length} rows=${scan.rows.length} buttons=${scan.buttons.length}`, 'ok');
    return scan;
  }

  function describeRow(row, ri) {
    const cells = row.cells.map((cell, ci) => ({
      index: ci,
      text: clip(cell.textContent, 80),
      links: Array.from(cell.querySelectorAll('a[href]')).map(a => a.href),
      inputs: Array.from(cell.querySelectorAll('input, select, textarea')).map(inp => ({ tag: inp.tagName.toLowerCase(), type: inp.type || '', editable: !inp.disabled && !inp.readOnly })),
      buttons: Array.from(cell.querySelectorAll('button, [role="button"]')).map(b => clip(b.textContent || b.getAttribute('aria-label'), 30)).filter(Boolean),
      checkbox: !!cell.querySelector('input[type="checkbox"]'),
    }));
    const dp = row.el.innerHTML.match(DP_RE);
    const asin = (dp && dp[1]) || (clip(row.el.textContent, 4000).match(ASIN_RE) || [])[1] || '';
    const allLinks = Array.from(row.el.querySelectorAll('a[href]')).map(a => a.href);
    return { rowIndex: ri, asin, indiaUrl: allLinks.find(u => /amazon\.in/.test(u)) || '', usaUrl: allLinks.find(u => /amazon\.com/.test(u)) || '', hasCheckbox: !!row.el.querySelector('input[type="checkbox"]'), cells };
  }
  function scanButtons() {
    const out = [];
    document.querySelectorAll('button, [role="button"], a.btn, input[type="button"], input[type="submit"]').forEach(el => {
      const label = clip(el.textContent || el.value || el.getAttribute('aria-label'), 40);
      if (!label) return;
      out.push({ label, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'), tag: el.tagName.toLowerCase(), interesting: /\b(pass|fail|link nf|usa link nf|reworking|rejected|next|last|prev|previous|download|upload|csv|all|rs|dp)\b/i.test(label) });
    });
    return out;
  }
  function scanInputs() {
    return Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea')).slice(0, 40).map(inp => ({ tag: inp.tagName.toLowerCase(), type: inp.type || '', placeholder: inp.placeholder || '', ariaLabel: clip(inp.getAttribute('aria-label'), 40), name: inp.name || '', editable: !inp.disabled && !inp.readOnly, nearbyHeader: nearestHeaderText(inp) }));
  }
  function scanSelects() {
    return Array.from(document.querySelectorAll('select')).map(sel => ({ name: sel.name || '', ariaLabel: clip(sel.getAttribute('aria-label'), 40), nearbyHeader: nearestHeaderText(sel), options: Array.from(sel.options).slice(0, 60).map(o => clip(o.textContent, 40)) }));
  }
  function scanCustomDropdowns() {
    return Array.from(document.querySelectorAll('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]')).slice(0, 20).map(el => ({ role: el.getAttribute('role') || el.getAttribute('aria-haspopup'), text: clip(el.textContent || el.getAttribute('aria-label'), 50), nearbyHeader: nearestHeaderText(el) }));
  }
  function scanTabs() {
    const out = []; const seen = new Set();
    document.querySelectorAll('[role="tab"], button, a').forEach(el => {
      const t = clip(el.textContent, 30);
      if (/\b(main file|pass|failed|reworking|rejected|link nf|usa link nf)\b/i.test(t) && !seen.has(t)) { seen.add(t); out.push({ text: t, active: el.getAttribute('aria-selected') === 'true' || /active|selected/i.test(el.className) }); }
    });
    return out;
  }
  function scanToggles() {
    const out = []; const seen = new Set();
    document.querySelectorAll('button, [role="button"], label, a').forEach(el => {
      const t = clip(el.textContent, 12);
      if (/^(all|rs|dp)$/i.test(t) && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push({ text: t, active: /active|selected/i.test(el.className) || el.getAttribute('aria-pressed') === 'true' }); }
    });
    return out;
  }
  function findToolbar() {
    let best = null;
    document.querySelectorAll('div, header, nav, section').forEach(c => {
      const txt = c.textContent || ''; let score = 0;
      ['Download CSV', 'Upload CSV', 'Link NF', 'USA Link NF', 'Main File', 'Pass', 'Failed'].forEach(k => { if (txt.includes(k)) score++; });
      if (score >= 3 && (!best || (score >= best.score && txt.length < best.len))) best = { el: c, score, len: txt.length };
    });
    return best?.el || null;
  }
  function nearestHeaderText(el) {
    const cell = el.closest('td, th, [role="gridcell"], [role="cell"]');
    if (!cell?.parentElement) return '';
    const idx = Array.from(cell.parentElement.children).indexOf(cell);
    const table = cell.closest('table, [role="grid"], [role="table"]');
    if (table && idx >= 0) { const headers = table.querySelectorAll('thead th, thead td, [role="columnheader"]'); if (headers[idx]) return clip(headers[idx].textContent, 40); }
    return '';
  }

  // ============================== RPC =======================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const t = msg?.type;
    const reply = (p) => sendResponse(p);
    // For async handlers: ALWAYS answer, even on rejection — otherwise the
    // listener returned `true` (channel held open) but never responds, and the
    // engine's sendMessage rejects with "message channel closed before a
    // response was received" (and the row hangs until the RPC times out).
    const replyErr = (e) => sendResponse({ ok: false, error: e?.message || String(e) });
    try {
      switch (t) {
        case 'DASH_PING': reply({ ok: true, ready: true, url: location.href }); return false;
        case 'SCAN': reply({ ok: true, scan: runScan() }); return false;
        case 'READ_PAGE_ROWS': reply(readPageRows()); return false;
        case 'GET_CATEGORY_OPTIONS': reply(getCategoryOptions(msg.asin)); return false;
        case 'GOTO_NEXT_PAGE': reply(gotoNextPage()); return false;
        case 'GOTO_FIRST_PAGE': reply(gotoFirstPage()); return false;
        case 'HIGHLIGHT_ROW': reply(highlightRow(msg.asin)); return false;
        case 'READ_PAGINATION': reply({ ok: true, pagination: readPagination() }); return false;
        case 'READ_ROW_FIELDS': { const fr = findRow(msg.asin); reply(fr.row ? { ok: true, fields: readRowFields(fr.grid, fr.row) } : { ok: false, error: 'row not found' }); return false; }
        // async ones (return Promises) — note .then(reply, replyErr) so a
        // rejection still answers the channel.
        case 'CLICK_PASS': clickPass(msg.asin, msg.opts).then(reply, replyErr); return true;
        case 'SET_USA_LINK': setUsaLink(msg.asin, msg.url).then(reply, replyErr); return true;
        case 'CHECK_ROW': checkRow(msg.asin).then(reply, replyErr); return true;
        case 'CLICK_LINK_NF': clickToolbar(/^link nf$/i, /^move to link nf$/i, 'Link NF').then(reply, replyErr); return true;
        case 'CLICK_USA_LINK_NF': clickToolbar(/^usa link nf$/i, /^move to usa link nf$/i, 'USA Link NF').then(reply, replyErr); return true;
        case 'WRITE_FIELD': writeField(msg.asin, msg.field, msg.value).then(reply, replyErr); return true;
        case 'SELECT_CATEGORY': selectCategory(msg.asin, msg.category).then(reply, replyErr); return true;
        case 'SET_FUNNEL': setFunnel(msg.asin, msg.funnel).then(reply, replyErr); return true;
        default: return false;
      }
    } catch (e) { reply({ ok: false, error: e?.message || String(e) }); return false; }
  });

  log(`Dropy dashboard content script ready on ${location.host}`, 'info');
  window.__davScan = runScan;
  window.__davRead = readPageRows;
})();
