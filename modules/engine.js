// modules/engine.js — the §1 validation state machine.
//
// Sequential by design: ONE Amazon tab in flight at a time, human-paced with a
// randomised throttle between page loads. The engine is the single source of
// truth for transitions; content scripts only report facts and execute atomic
// dashboard actions on command.
//
// Persistence (chrome.storage.local) makes a browser restart / SW eviction
// resume cleanly: processed ASINs are skipped, never re-scraped. Dry-run does
// every field write but withholds the status-changing clicks (Pass / Link NF /
// USA Link NF) so the human can audit accuracy before going live.

import { K, getSettings, PAGE } from '../config.js';
import * as tab from './amazon-tab.js';
import { analyzePrompt, parseAnalyze, analyzeApi } from './llm.js';
import { askWeb, isWebMode, closeTab as closeLlmTab, setWindow as setLlmWindow } from './llm-web.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.round(a + Math.random() * (b - a));

const IN_ORIGIN = 'https://www.amazon.in';
const COM_ORIGIN = 'https://www.amazon.com';

export function createEngine(ctx) {
  // ctx: { log(text,kind,asin), emit(payload), sendToDashboard(msg) }
  const s = {
    running: false, paused: false, pausedByCaptcha: false,
    stopRequested: false, pauseRequested: false,
    status: 'Idle', currentAsin: null, step: '', page: null, totalPages: null,
    queue: [],                 // rowData objects pending on the current page
    processed: new Set(),
    counters: { processed: 0, passed: 0, failed: 0, linkNf: 0, usaLinkNf: 0, flagged: 0 },
    rowRecords: {},
    loopActive: false,
    resetSeq: 0,               // bumped by reset() so an exiting loop can detect it
    usZipSet: false,
    active: false,             // "a run is in-flight" — survives restart to auto-resume.
                               // true from Start/Resume; cleared on Stop/Pause/Reset/Done.
                               // A hard SW kill leaves it true (finally never ran) → resume.
  };

  // ---- persistence ----------------------------------------------------------
  async function hydrate() {
    const d = await chrome.storage.local.get([K.PROCESSED, K.COUNTERS, K.ROW_RECORDS, K.RUN_STATE]);
    if (Array.isArray(d[K.PROCESSED])) s.processed = new Set(d[K.PROCESSED]);
    if (d[K.COUNTERS]) s.counters = { ...s.counters, ...d[K.COUNTERS] };
    if (d[K.ROW_RECORDS]) s.rowRecords = d[K.ROW_RECORDS];
    const rs = d[K.RUN_STATE] || {};
    s.status = rs.status || 'Idle';
    s.page = rs.page ?? null;
    s.totalPages = rs.totalPages ?? null;
    s.active = !!rs.active;
  }
  const hydrated = hydrate();

  let persistTimer = null;
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.local.set({
        [K.PROCESSED]: Array.from(s.processed),
        [K.COUNTERS]: s.counters,
        [K.ROW_RECORDS]: s.rowRecords,
        [K.RUN_STATE]: { status: s.status, page: s.page, totalPages: s.totalPages, paused: s.paused, pausedByCaptcha: s.pausedByCaptcha, active: s.active },
      }).catch(() => {});
    }, 300);
  }

  function emit(extra) {
    ctx.emit?.({
      running: s.running, paused: s.paused, pausedByCaptcha: s.pausedByCaptcha,
      status: s.status, currentAsin: s.currentAsin, step: s.step,
      page: s.page, totalPages: s.totalPages,
      queueRemaining: s.queue.length, counters: s.counters,
      processedCount: s.processed.size, ...extra,
    });
  }
  function setStep(step, asin) { s.step = step; if (asin !== undefined) s.currentAsin = asin; emit(); }
  function log(t, k, a) { ctx.log?.(t, k, a); }
  function highlight(asin) { ctx.sendToDashboard({ type: 'HIGHLIGHT_ROW', asin }).catch(() => {}); }

  // ---- cancellation helpers -------------------------------------------------
  class CaptchaPause extends Error { constructor() { super('captcha'); this.captcha = true; } }
  class Stopped extends Error { constructor() { super('stopped'); this.stopped = true; } }
  function checkControl() {
    if (s.stopRequested) throw new Stopped();
    if (s.pauseRequested) { s.paused = true; s.status = 'Paused'; persist(); throw new Stopped(); } // pause exits the loop; resume re-enters
  }

  // Keep the run's Amazon + LLM tabs in the dashboard's CURRENT window (it may be
  // closed/reopened → new windowId). Always sync (pass null to clear a stale id).
  async function syncWorkingWindow() {
    try { const w = await ctx.getWorkingWindowId?.(); tab.setWindow(w == null ? null : w); setLlmWindow(w == null ? null : w); } catch {}
  }

  // ---- throttled, retrying Amazon navigation --------------------------------
  async function loadAmazon(url, settings) {
    await sleep(rand(settings.throttleMinMs, settings.throttleMaxMs));
    checkControl();
    // Bring the Amazon tab forward BEFORE the load so the user watches it open
    // (India/USA), then again after so it wins over anything that stole focus.
    const show = settings.showWorkingTab !== false;
    if (show) { try { await tab.ensureTab(); await tab.bringToFront(); } catch {} }
    let r;
    try {
      r = await tab.navigate(url, settings.pageTimeoutMs);
    } catch (e1) {
      log(`load failed (${e1.message}) — retrying once`, 'warn');
      await sleep(rand(settings.throttleMinMs, settings.throttleMaxMs));
      checkControl();
      r = await tab.navigate(url, settings.pageTimeoutMs); // throws on 2nd failure -> row flagged by caller
    }
    if (show) { try { await tab.bringToFront(); } catch {} }
    return r;
  }

  // Detect page type, re-checking an ambiguous 'other' a few times in case the
  // page is still hydrating (prevents false Not-Found). On CAPTCHA, bring the
  // tab to the front and AUTO-RESUME: poll until the user clears it, then carry
  // on — no manual Resume needed.
  async function detect() {
    for (;;) {
      let r;
      for (let i = 0; i < 3; i++) {
        r = await tab.rpc({ type: 'DETECT_PAGE_TYPE' });
        if (r?.pageType === PAGE.CAPTCHA) break;
        if (r?.pageType && r.pageType !== PAGE.OTHER) break;  // decisive
        await sleep(700); // 'other' → maybe still loading; wait and re-check
      }
      if (r?.pageType === PAGE.CAPTCHA) {
        await tab.bringToFront();
        s.pausedByCaptcha = true;
        s.status = 'CAPTCHA — solve it in the Amazon tab; auto-resumes when cleared';
        persist(); emit();
        log('CAPTCHA detected — solve it in the open tab; the run auto-resumes when cleared.', 'warn');
        const cleared = await waitCaptchaCleared();
        if (!cleared) throw new Stopped();   // user hit Stop/Pause during the wait
        s.pausedByCaptcha = false;
        s.status = 'Running';
        emit();
        log('CAPTCHA cleared — resuming.', 'ok');
        await sleep(800);
        continue; // re-detect the now-cleared page
      }
      return r?.pageType || PAGE.OTHER;
    }
  }

  async function waitCaptchaCleared() {
    while (!s.stopRequested && !s.pauseRequested) {
      await sleep(3000);
      try {
        const r = await tab.rpc({ type: 'DETECT_PAGE_TYPE' });
        if (r?.pageType && r.pageType !== PAGE.CAPTCHA) return true;
      } catch { /* tab navigating; keep waiting */ }
    }
    return false;
  }

  // ---- per-row processing (the §1 algorithm) --------------------------------
  async function processRow(row, settings) {
    const asin = row.asin;
    s.currentAsin = asin;
    const rec = { asin, title: row.title, brand: row.brand, ts: Date.now(), dryRun: settings.dryRun, flags: [], branch: 'pass' };
    // Bring the DASHBOARD tab forward for dashboard phases (Amazon scraping
    // brings the Amazon tab forward via loadAmazon; the LLM call brings its tab).
    const showDash = async () => { if (settings.showWorkingTab !== false) await ctx.focusDashboard?.(); };
    await syncWorkingWindow();   // re-anchor tabs to the dashboard window each product
    await showDash();
    highlight(asin);  // mark the row on the dashboard

    // 2) India link — the India leg must run on amazon.in. If the link is a
    //    .com URL, rewrite it to .in (same ASIN/path) and use that. If the .in
    //    page isn't a real product, the row goes to Link NF below.
    let indiaUrl = row.indiaUrl || (row.asin ? `${IN_ORIGIN}/dp/${row.asin}` : '');
    if (!indiaUrl) {
      rec.branch = 'flagged'; rec.flags.push('no India link in row'); finalizeRecord(rec); s.counters.flagged++;
      log(`${asin}: no India link — flagged`, 'warn', asin); return 'flagged';
    }
    if (/amazon\.com/i.test(hostOf(indiaUrl))) {
      const fixed = rewriteAmazonDomain(indiaUrl, 'in');
      log(`${asin}: India link was .com → using .in: ${fixed}`, 'info', asin);
      rec.indiaLinkRewritten = `${shortHost(indiaUrl)}→amazon.in`;
      indiaUrl = fixed;
    } else if (!/amazon\.in/i.test(hostOf(indiaUrl))) {
      // Not an Amazon link at all (e.g. junk/test rows) — fall back to
      // amazon.in/dp/ASIN so it resolves fast instead of hanging on a dead host.
      if (row.asin) { indiaUrl = `${IN_ORIGIN}/dp/${row.asin}`; }
      else { rec.branch = 'flagged'; rec.flags.push('India link is not an Amazon URL'); finalizeRecord(rec); s.counters.flagged++; log(`${asin}: India link not Amazon & no ASIN — flagged`, 'warn', asin); return 'flagged'; }
    }
    rec.indiaUrlUsed = indiaUrl;
    setStep('open India link', asin);
    log(`${asin}: India → ${indiaUrl}`, 'info', asin);
    await loadAmazon(indiaUrl, settings);
    let pt = await detect();
    const indiaLinkNf = async (why) => {
      rec.branch = 'india_link_nf';
      await terminalNF(asin, 'CHECK_ROW', 'CLICK_LINK_NF', settings, rec);
      s.counters.linkNf++; finalizeRecord(rec);
      log(`${asin}: ${why} → Link NF${settings.dryRun ? ' [dry-run]' : ''}`, 'ok', asin);
    };
    if (pt !== PAGE.PRODUCT) {
      // India link not working → Link NF IMMEDIATELY. The India leg NEVER
      // title-searches (user rule 2026-06-11) — only the USA leg searches. Also
      // faster at scale (one fewer search + page load per dead India link).
      await indiaLinkNf(`India not found (${pt})`); return 'link_nf';
    }

    setStep('scrape India', asin);
    let india = (await tab.rpc({ type: 'SCRAPE_PRODUCT' }))?.data || {};
    // If the DIRECT .in link redirected to a DIFFERENT product, don't trust it —
    // search by title (else its price/BSR/funnel would all be for the wrong item).
    if (india.asin && india.asin.toUpperCase() !== asin.toUpperCase()) {
      // India link redirected to a DIFFERENT product → treat as not working →
      // Link NF (the India leg does not search).
      log(`${asin}: India .in showed a DIFFERENT product (${india.asin}) — Link NF (India leg does not search)`, 'warn', asin);
      await indiaLinkNf('India link redirected / not the product'); return 'link_nf';
    }
    rec.bsr = india.bsrPrimary; rec.bsrIndia = india.bsrPrimary; rec.title = india.title || rec.title;
    rec.amazonCategory = india.categoryText || ''; rec.amazonCategoryPath = india.categoryPath || [];

    // 3) Funnel RS/DP — verified/corrected FIRST, right after the India scrape
    //    (needs only the India BSR). India BSR < threshold => RS; null or >= => DP.
    await showDash();
    setStep('funnel', asin);
    await verifyAndFixFunnel(rec, settings);
    await sleep(300); // let the row re-render settle after a funnel change

    // 4) weight + category via ONE combined LLM call (reliable; no 2nd-call bleed)
    setStep('analyze (weight+category)', asin);
    // Weight (user rules 2026-06-11): Amazon's listed weight is REAL data and is
    // TRUSTED. We only spend an LLM weight estimate when it's NEEDED (Amazon
    // weight missing / physically impossible) or FREE (the LLM already runs for
    // the category) — see `needWeight` below. This keeps large-scale runs fast.
    // Treat 0 / NaN / negative as MISSING (not a real weight) so the LLM/USA
    // fallback fires instead of writing a bogus "0" into the cell.
    const amazonGrams = india.weightGrams > 0 ? india.weightGrams : null;
    let grams = amazonGrams, weightSource = amazonGrams != null ? india.weightSource : null, weightConf = null;
    let llmGrams = null, llmConf = null;
    // Digital / weightless items (eBooks, audiobooks, downloads) → 0 is correct.
    // Only when Amazon reports NO weight (a physical book / Kindle accessory has one).
    const isWeightless = amazonGrams == null && isWeightlessProduct(rec.title, rec.amazonCategory);
    if (isWeightless) { grams = 0; weightSource = 'digital'; weightConf = 'high'; log(`${asin}: digital/weightless item → weight 0`, 'info', asin); }
    // Category options (fetched once; also reused when applying the category).
    let catOptions = [];
    try {
      const o = await ctx.sendToDashboard({ type: 'GET_CATEGORY_OPTIONS', asin });
      if (o?.ok) {
        catOptions = (o.options || []).filter(c => c && !/^\s*(select|choose|--|\s*category\s*$)/i.test(c));
        rec._catSelected = o.selected || '';   // pre-filled category (for cross-verify)
      }
    } catch {}
    rec._catOptions = catOptions;

    // A curated OVERRIDE (e.g. wig → "Beauty - Other Products") wins outright and
    // skips the category LLM — fastest + exactly what the user wants.
    rec._catOverride = catOptions.length ? categoryOverride(rec.title, rec.amazonCategory, catOptions) : null;
    // Force the department catch-all for no-specific-category product types
    // (cleaning consumables…), using the breadcrumb's OWN root department.
    if (!rec._catOverride && catOptions.length && FORCE_DEPT_CATCHALL_RE.test(`${rec.title || ''} ${rec.amazonCategory || ''}`)) {
      rec._catOverride = mainTagCategory(rec.amazonCategoryPath, rec.amazonCategory, catOptions);
    }
    if (rec._catOverride) log(`${asin}: category override → "${rec._catOverride}" (curated rule) — skipping LLM`, 'info', asin);
    // AMAZON TREE PREFERRED, NO LLM unless needed (user rule 2026-06-11): the
    // breadcrumb is authoritative. If it matches ANY dropdown option word at all
    // (viaAmazon) we use the breadcrumb and DON'T call the category LLM — the
    // dept-guard / breadcrumb-support / main-tag catch-all clean up weak/wrong
    // picks. The LLM runs for category ONLY when the breadcrumb yields NOTHING
    // (no option word matched) — i.e. the category is "almost not given".
    const hCat = catOptions.length ? categorize(rec.title, rec.brand, catOptions, rec.amazonCategory, rec.amazonCategoryPath) : null;
    const breadcrumbHasMatch = !!(hCat && hCat.viaAmazon);
    if (breadcrumbHasMatch) log(`${asin}: category from Amazon breadcrumb — skipping LLM`, 'info', asin);
    const needCategory = settings.useLlmCategory && catOptions.length > 0 && !rec._catOverride && !breadcrumbHasMatch;
    // Weight needs the LLM only when Amazon's value is MISSING or IMPOSSIBLE
    // (below its liquid-volume floor) — OR when the LLM is already being called
    // for the category (weight rides along free, giving a cross-verify at no
    // extra cost). Amazon weight present & plausible + strong category ⇒ NO call.
    const weightModeOn = !!settings.weightMode && settings.weightMode !== 'off';
    const floorG = volumeFloorGrams(rec.title);
    const weightNeedsLlm = amazonGrams == null || (floorG && amazonGrams < floorG);
    const needWeight = !isWeightless && weightModeOn && (weightNeedsLlm || needCategory);
    if ((needWeight || needCategory) && llmChannelReady(settings)) {
      let a = null, lastErr = null;
      for (let attempt = 0; attempt < 2 && !a; attempt++) {   // retry once — web UI is occasionally flaky
        try {
          a = await llmAnalyze({ title: rec.title, brand: rec.brand, amazonCategory: rec.amazonCategory, options: catOptions, needWeight, needCategory, settings });
        } catch (e) { lastErr = e; if (attempt === 0) { log(`${asin}: LLM retry after: ${e.message}`, 'warn', asin); await sleep(1200); } }
      }
      if (a) {
        if (needWeight && a.grams != null) { llmGrams = a.grams; llmConf = a.weightConfidence; }
        if (needCategory) rec._catLlm = { category: a.category, confidence: a.categoryConfidence };
      } else {
        rec.flags.push('LLM analyze failed: ' + (lastErr?.message || 'unknown'));
        log(`${asin}: LLM analyze failed: ${lastErr?.message}`, 'err', asin);
      }
    }
    // Reconcile Amazon-listed weight vs the LLM estimate. Runs even when the LLM
    // returned nothing, so an Amazon weight below its own contents still gets flagged.
    if (needWeight && (amazonGrams != null || llmGrams != null)) {
      const r = reconcileWeight(amazonGrams, india.weightRaw, llmGrams, llmConf, rec.title, rec, settings);
      grams = r.grams; weightSource = r.source != null ? r.source : weightSource; weightConf = r.confidence;
      if (grams != null) {
        const both = amazonGrams != null && llmGrams != null ? ` (amazon ${amazonGrams}g, llm ${llmGrams}g)` : '';
        const good = weightConf === 'high' || weightSource === 'amazon (verified)';
        log(`${asin}: weight ${grams}g [${weightSource}]${both}`, good ? 'ok' : 'warn', asin);
      }
    }

    // Weight is COMPULSORY. If still missing, fall back to the OTHER web LLM
    // (e.g. Gemini failed → try ChatGPT), weight-only, with a retry.
    if (grams == null && needWeight) {
      const fb = fallbackWeightMode(settings.weightMode);
      log(`${asin}: weight still missing — trying backup ${fb}`, 'warn', asin);
      for (let attempt = 0; attempt < 2 && grams == null; attempt++) {
        try {
          const a2 = await llmAnalyze({ title: rec.title, brand: rec.brand, amazonCategory: rec.amazonCategory, options: [], needWeight: true, needCategory: false, settings, mode: fb });
          if (a2.grams != null) {
            grams = a2.grams; weightSource = 'llm:' + fb; weightConf = a2.weightConfidence;
            if (weightConf !== 'high') rec.flags.push(`weight LLM ${weightConf} (verify)`);
            log(`${asin}: weight via backup ${fb} = ${grams}g (${weightConf})`, weightConf === 'high' ? 'ok' : 'warn', asin);
          }
        } catch (e) { if (attempt === 0) { await sleep(1200); } else { rec.flags.push('weight backup failed: ' + e.message); } }
      }
    }
    if (grams == null && needWeight) { rec.flags.push('WEIGHT MISSING — could not resolve (verify)'); log(`${asin}: WEIGHT MISSING after all fallbacks`, 'err', asin); }
    else if (grams == null) rec.flags.push('weight missing (fallback off)');
    rec.weightGrams = grams; rec.weightSource = weightSource; rec.weightConfidence = weightConf;

    // 5) write Weight(G) + INR --------------------------------------------
    await showDash();
    if (grams != null) await writeField(asin, 'weight', grams, rec);
    if (india.priceValue != null && india.currency === 'INR') { rec.inr = india.priceValue; await writeField(asin, 'inr', india.priceValue, rec); }
    else if (india.priceValue != null) { rec.inr = india.priceValue; await writeField(asin, 'inr', india.priceValue, rec); rec.flags.push(`INR currency was ${india.currency || 'unknown'} (verify)`); }
    else rec.flags.push('INR price not found on amazon.in (verify)');

    // 6) USA link ----------------------------------------------------------
    const usaDone = await handleUsaLeg(row, rec, settings);
    if (usaDone === 'usa_link_nf') { s.counters.usaLinkNf++; finalizeRecord(rec); return 'usa_link_nf'; }

    // Weight fallback from amazon.com when amazon.in listed none (e.g. batteries
    // Amazon.in files without an Item Weight). Prevents a bogus/blank 0 in the cell.
    if (rec.weightGrams == null && rec.usaWeightGrams > 0) {
      rec.weightGrams = rec.usaWeightGrams; rec.weightSource = 'amazon-usa'; rec.weightConfidence = null;
      rec.flags = rec.flags.filter(f => !/WEIGHT MISSING/.test(f));   // it's resolved now — drop the stale flag
      rec.flags.push(`weight from amazon.com (.in had none): ${rec.usaWeightGrams}g (verify)`);
      log(`${asin}: weight from amazon.com = ${rec.usaWeightGrams}g (.in had none)`, 'ok', asin);
      await writeField(asin, 'weight', rec.weightGrams, rec);
    }

    // 7) category ----------------------------------------------------------
    await showDash();
    setStep('select category', asin);
    await handleCategory(asin, rec, settings);

    // Verify every field actually stuck (the row auto-saves/re-renders and can
    // wipe earlier writes); re-write any that reverted before attempting Pass.
    await showDash();
    setStep('verify fields', asin);
    await ensureFieldsStick(asin, rec);

    // Final Source-Link write right before Pass (freshest = smallest revert window).
    if (rec.sourceLink) await writeField(asin, 'sourceLink', rec.sourceLink, rec);

    // 8) Pass — only when EVERYTHING is correct (funnel included). -----------
    await showDash();
    highlight(asin);  // re-apply (field writes re-rendered the row)
    if (settings.dryRun) {
      rec.passed = false; log(`${asin}: [dry-run] would click Pass`, 'info', asin);
    } else if (rec.funnelOk === false) {
      // Don't Pass with a wrong funnel — flag for manual fix (user rule 2026-06-10).
      rec.passed = false; rec.flags.push('not passed — funnel could not be set correctly');
      log(`${asin}: NOT passed — funnel is wrong (couldn't set ${rec.funnel}). Fix funnel, then it can pass.`, 'warn', asin);
    } else {
      // Peek the dashboard's verdict WITHOUT committing.
      let peek = await ctx.sendToDashboard({ type: 'CLICK_PASS', asin, opts: { peek: true } });
      // RECOVER A FAIL (user rules 2026-06-10/11) in two stages, cheap → expensive.
      // Stage 1 (cheap, no reloads): re-cross-check that weight / INR / USD / source
      // link / category / funnel are all still CORRECT in the row — a field that
      // reverted on a re-render can cause a spurious Fail — then re-peek.
      if (peek?.ok && peek.verdict === 'fail') {
        log(`${asin}: Move Fail — re-checking weight/category/INR/USD/funnel before accepting`, 'warn', asin);
        await ensureFieldsStick(asin, rec);
        peek = await ctx.sendToDashboard({ type: 'CLICK_PASS', asin, opts: { peek: true } });
      }
      // Stage 2 (expensive): still FAIL and unprofitable (India price < USA price =
      // costs more to source in the USA than it sells for in India) → search .com
      // for the SAME product cheaper, repoint USA + Source links, re-scrape, re-peek.
      if (peek?.ok && peek.verdict === 'fail') {
        const rate = settings.usdToInrRate || 95;
        const indiaUsd = rec.inr != null ? rec.inr / rate : null;
        if (indiaUsd != null && rec.usd != null && indiaUsd < rec.usd - 0.01) {
          log(`${asin}: Move Fail + India ($${indiaUsd.toFixed(2)} from ₹${rec.inr}) < USA ($${rec.usd}) — searching .com for a cheaper USA source (target < $${indiaUsd.toFixed(2)})`, 'warn', asin);
          const rescued = await rescueCheaperUsa(rec, settings, indiaUsd);
          if (rescued) { await ensureFieldsStick(asin, rec); peek = await ctx.sendToDashboard({ type: 'CLICK_PASS', asin, opts: { peek: true } }); }
        }
      }
      const pr = peek?.ok ? await ctx.sendToDashboard({ type: 'CLICK_PASS', asin }) : peek;
      rec.passed = !!pr?.ok;
      if (pr?.ok) {
        // The dashboard decides the verdict; we click whichever it shows.
        rec.verdict = pr.verdict || 'pass';
        if (rec.verdict === 'fail') { s.counters.failed = (s.counters.failed || 0) + 1; rec.branch = 'fail'; rec.failReason = pr.failReason || peek.failReason || ''; log(`${asin}: dashboard FAILED → Move Fail${rec.failReason ? ' (' + rec.failReason + ')' : ''} → Failed File`, 'warn', asin); }
        else { s.counters.passed++; log(`${asin}: ${rec.usaRescued ? 'PASS (rescued cheaper USA)' : 'PASS'}`, 'ok', asin); }
      }
      else {
        rec.flags.push('Pass not done: ' + (pr?.error || ''));
        // If a required field is empty, that's WHY Move Pass isn't shown — log it
        // plainly. Only dump the STATUS HTML when everything looks filled but the
        // button still isn't found (the only case needing selector work).
        if (pr?.missing?.length) {
          const onlyInr = pr.missing.length === 1 && pr.missing[0] === 'inr';
          if (onlyInr) { rec.flags.push('no India price (INR) — left for manual review'); log(`${asin}: not passed — no India price (INR); other fields filled, left for manual review`, 'warn', asin); }
          else log(`${asin}: not passed — fields empty: ${pr.missing.join(', ')} (fix these → Move Pass appears)`, 'warn', asin);
        } else {
          log(`${asin}: Pass failed — ${pr?.error}`, 'err', asin);
          if (pr?.statusHtml) { rec.passDebugHtml = pr.statusHtml; log(`${asin}: STATUS-CELL (copy & send): ${String(pr.statusHtml).slice(0, 900)}`, 'info', asin); }
          if (pr?.sourceHtml) { rec.sourceDebugHtml = pr.sourceHtml; log(`${asin}: SOURCELINK-CELL (copy & send): ${String(pr.sourceHtml).slice(0, 900)}`, 'info', asin); }
          if (pr?.categoryHtml) { rec.categoryDebugHtml = pr.categoryHtml; log(`${asin}: CATEGORY-CELL (copy & send): ${String(pr.categoryHtml).slice(0, 700)}`, 'info', asin); }
        }
      }
    }

    finalizeRecord(rec);
    return 'pass';
  }

  async function handleUsaLeg(row, rec, settings) {
    const asin = rec.asin;
    // The USA leg must run on amazon.com. If the link is a .in URL, rewrite it
    // to .com (same ASIN/path). If the .com page isn't a real product, fall
    // through to the title-search + §6 match, then USA Link NF.
    let usaUrl = row.usaUrl;
    if (usaUrl && /amazon\.in/i.test(hostOf(usaUrl))) {
      const fixed = rewriteAmazonDomain(usaUrl, 'com');
      log(`${asin}: USA link was .in → using .com: ${fixed}`, 'info', asin);
      rec.usaLinkRewritten = `${shortHost(usaUrl)}→amazon.com`;
      usaUrl = fixed;
    } else if (usaUrl && !/amazon\.com/i.test(hostOf(usaUrl))) {
      usaUrl = asin ? `${COM_ORIGIN}/dp/${asin}` : usaUrl;   // non-Amazon → .com/dp/ASIN
    }
    if (usaUrl) {
      rec.usaUrlUsed = usaUrl;
      setStep('open USA link', asin);
      log(`${asin}: USA → ${usaUrl}`, 'info', asin);
      try {
        await loadAmazon(usaUrl, settings);
        const pt = await detect();
        if (pt === PAGE.PRODUCT) {
          const usa = await scrapeUsa(usaUrl, settings);
          const loaded = (usa.asin || '').toUpperCase();
          // amazon.com redirects a dead ASIN to a DIFFERENT product — don't trust
          // that price/link; treat as not-found and search by title instead.
          if (loaded && loaded !== asin.toUpperCase()) {
            log(`${asin}: USA .com showed a DIFFERENT product (${loaded}) — searching .com by title`, 'warn', asin);
          } else {
            rec.bsrUsa = usa.bsrPrimary; if (usa.weightGrams > 0) rec.usaWeightGrams = usa.weightGrams;
            if (!rec.amazonCategory && usa.categoryText) rec.amazonCategory = usa.categoryText;
            await writeUsd(asin, usa, rec);
            rec.sourceLink = usa.canonicalUrl; await writeField(asin, 'sourceLink', usa.canonicalUrl, rec);
            return 'ok';
          }
        } else {
          // dead USA link -> fall through to search branch
          log(`${asin}: USA link ${pt} → searching .com by title`, 'info', asin);
        }
      } catch (e) {
        if (e.captcha || e.stopped) throw e;   // never swallow a pause/stop
        rec.flags.push('USA link load failed: ' + e.message);
      }
    }
    // USA-LINK-NF branch: search .com for the India title + §6 three-check.
    return await usaSearchBranch(rec, settings);
  }

  // India recovery: when the .in link is dead, search amazon.in for the row's
  // title and open a confident §6 match. Returns true if a product page is now
  // loaded in the managed tab (caller then scrapes it normally).
  async function indiaSearchAndOpen(rec, settings) {
    const query = rec.title;
    if (!query) { rec.flags.push('no title to search amazon.in'); return false; }
    setStep('search .in + match', rec.asin);
    try {
      await loadAmazon(tab.searchUrl(IN_ORIGIN, query), settings);
      await detect(); // captcha guard
      const sm = await tab.rpc({ type: 'SEARCH_AND_MATCH', query, brand: rec.brand });
      rec.indiaSearchCandidates = (sm?.candidates || []).map(c => ({ asin: c.asin, title: c.title, sim: c.sim, confident: c.confident, reasons: c.reasons }));
      if (sm?.ok && sm.match) {
        rec.indiaMatchAsin = sm.match.asin; rec.indiaMatchedViaSearch = true;
        rec.flags.push('India matched via search (verify)');
        await loadAmazon(sm.match.link, settings);
        const pt = await detect();
        return pt === PAGE.PRODUCT;
      }
    } catch (e) {
      if (e.captcha || e.stopped) throw e;
      rec.flags.push('India search failed: ' + e.message);
    }
    return false;
  }

  async function usaSearchBranch(rec, settings) {
    const asin = rec.asin;
    const query = rec.title;
    setStep('search .com + match', asin);
    if (!query) { rec.flags.push('no title to search'); return await terminalUsaNF(rec, settings); }
    try {
      await loadAmazon(tab.searchUrl(COM_ORIGIN, query), settings);
      await detect(); // captcha guard on the search page
      const sm = await tab.rpc({ type: 'SEARCH_AND_MATCH', query, brand: rec.brand });
      rec.searchCandidates = (sm?.candidates || []).map(c => ({ asin: c.asin, title: c.title, sim: c.sim, confident: c.confident, reasons: c.reasons }));
      if (sm?.ok && sm.match) {
        rec.usaMatchAsin = sm.match.asin; rec.usaMatchedViaSearch = true;
        rec.flags.push('USA matched via search (verify)');
        // open the matched product page for an accurate price + canonical URL
        await loadAmazon(sm.match.link, settings);
        const pt = await detect();
        if (pt === PAGE.PRODUCT) {
          const usa = await scrapeUsa(sm.match.link, settings);
          rec.bsrUsa = usa.bsrPrimary;
          if (!rec.amazonCategory && usa.categoryText) rec.amazonCategory = usa.categoryText;
          await writeUsd(asin, usa, rec);
          rec.sourceLink = usa.canonicalUrl || sm.match.link; await writeField(asin, 'sourceLink', rec.sourceLink, rec);
          log(`${asin}: USA match ${sm.match.asin} (sim ${sm.match.sim?.toFixed(2)}) → filled`, 'ok', asin);
          return 'ok';
        }
        rec.flags.push('matched product page not loadable');
      }
      log(`${asin}: no confident .com match → USA Link NF${settings.dryRun ? ' [dry-run]' : ''}`, 'ok', asin);
    } catch (e) {
      if (e.captcha || e.stopped) throw e;
      rec.flags.push('USA search failed: ' + e.message);
    }
    return await terminalUsaNF(rec, settings);
  }

  async function terminalUsaNF(rec, settings) {
    rec.branch = 'usa_link_nf';
    await terminalNF(rec.asin, 'CHECK_ROW', 'CLICK_USA_LINK_NF', settings, rec);
    return 'usa_link_nf';
  }

  // CHECK_ROW (tick the row checkbox) then click the toolbar NF button. The
  // toolbar button only enables once a row is selected, so we tick, wait, then
  // click. Withheld in dry-run.
  async function terminalNF(asin, checkType, clickType, settings, rec) {
    if (settings.dryRun) { rec.dryRunWithheld = clickType; return; }
    const cr = await ctx.sendToDashboard({ type: checkType, asin });
    if (!cr?.ok) {
      // CRITICAL: if we couldn't tick THIS row's checkbox, do NOT click the
      // toolbar NF button — it acts on whatever rows are checked and could
      // mark the wrong product. Flag and skip instead.
      rec.flags.push(`${checkType} failed: ${cr?.error || ''} — ${clickType} SKIPPED (would risk wrong row)`);
      log(`${asin}: ${checkType} failed — ${clickType} skipped to avoid wrong-row action`, 'err', asin);
      return;
    }
    await sleep(500); // let the toolbar button enable after selection
    const cl = await ctx.sendToDashboard({ type: clickType });
    if (!cl?.ok) { rec.flags.push(`${clickType} failed: ${cl?.error || ''}`); log(`${asin}: ${clickType} failed — ${cl?.error}`, 'err', asin); }
    else log(`${asin}: ${clickType} done`, 'ok', asin);
  }

  async function handleCategory(asin, rec, settings) {
    // Options were fetched in step 4; re-fetch only if missing.
    let options = rec._catOptions;
    if (!options || !options.length) {
      const opts = await ctx.sendToDashboard({ type: 'GET_CATEGORY_OPTIONS', asin });
      options = (opts?.options || []).filter(o => o && !/^\s*(select|choose|--|\s*category\s*$)/i.test(o));
    }
    if (!options.length) { rec.flags.push('no category options found'); return; }

    const amazonCat = rec.amazonCategory || '';   // Amazon's own breadcrumb — the primary signal
    const norm = v => String(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let chosen = null, confident = false, source = 'heuristic';
    let explicitNone = false;

    // Curated OVERRIDE (e.g. wig → "Beauty - Other Products") — highest priority,
    // beats heuristic AND LLM. Resolved against the live option list in step 4.
    if (rec._catOverride) {
      rec.category = rec._catOverride; rec.categoryConfident = true; rec.categorySource = 'override';
      const pf = rec._catSelected || '';
      if (pf && norm(pf) === norm(rec._catOverride)) { rec.categoryAlreadyCorrect = true; log(`${asin}: category already correct (${rec._catOverride}) — kept`, 'ok', asin); return; }
      const sel = await ctx.sendToDashboard({ type: 'SELECT_CATEGORY', asin, category: rec._catOverride });
      if (!sel?.ok) { rec.flags.push('category select failed: ' + (sel?.error || '')); log(`${asin}: category select failed — ${sel?.error}`, 'err', asin); if (sel?.cellHtml) rec.categoryDebugHtml = sel.cellHtml; }
      else { log(`${asin}: category → ${rec._catOverride} (override)${pf ? ` [corrected from "${pf}"]` : ''}`, 'ok', asin); if (pf && norm(pf) !== norm(rec._catOverride)) rec.flags.push(`category corrected: "${pf}" → "${rec._catOverride}"`); }
      return;
    }

    // Amazon's breadcrumb is the AUTHORITATIVE reference (user 2026-06-11 "take
    // reference for category"). Compute it ALWAYS — not just as an LLM fallback —
    // so we can cross-check the LLM's guess against Amazon's own classification.
    const h = categorize(rec.title, rec.brand, options, amazonCat, rec.amazonCategoryPath);
    const breadcrumbConfident = h.confident && h.viaAmazon;   // a real breadcrumb-driven match

    // Use the category from the combined LLM call made in step 4 (rec._catLlm).
    const r = rec._catLlm;
    if (r) {
      source = 'llm';
      rec.categoryLlmRaw = r.category;
      if (r.category && !/^none$/i.test(r.category)) {
        const exact = matchOption(options, r.category);
        if (exact) { chosen = exact; confident = r.confidence !== 'low'; }
        else rec.flags.push(`category LLM returned "${r.category}" not in list`);
      } else {
        explicitNone = true; // model says nothing fits — respect it (books/irrelevant)
        log(`${asin}: category — LLM says NONE fits (likely a book/irrelevant item)`, 'warn', asin);
      }
    }

    // Breadcrumb beats a disagreeing LLM guess: Amazon classified this product
    // itself, so when its breadcrumb confidently maps to a DIFFERENT option than
    // the LLM picked, prefer the breadcrumb and flag the disagreement. (Don't
    // override an explicit NONE — that protects the book/eBook case.)
    if (breadcrumbConfident && !explicitNone) {
      if (chosen && norm(chosen) !== norm(h.category)) {
        rec.flags.push(`category: breadcrumb "${h.category}" vs LLM "${chosen}" — used breadcrumb (verify)`);
        log(`${asin}: category breadcrumb "${h.category}" overrides LLM "${chosen}"`, 'warn', asin);
        chosen = h.category; confident = true; source = 'amazon-breadcrumb';
      } else if (!chosen) {                       // LLM gave nothing usable → use the breadcrumb
        chosen = h.category; confident = true; source = 'amazon-breadcrumb';
      } else {
        source = 'llm+breadcrumb';                // they AGREE → strongest signal
      }
    }

    // Heuristic when the LLM wasn't used at all (and breadcrumb wasn't confident).
    if (chosen === null && !explicitNone && !r) {
      if (h.confident) { chosen = h.category; confident = true; source = h.viaAmazon ? 'amazon-breadcrumb' : 'heuristic'; }
    }

    // DEPARTMENT GUARD: a chosen category MUST be in the same department as the
    // breadcrumb ROOT (path[0]). A cross-department pick is a token-collision error
    // — e.g. a Beauty product → "Automotive … Gloves" (matched "gloves"), or a PET
    // supplement whose breadcrumb is "Pet Supplies › Dogs › HEALTH Supplies ›
    // Supplements & VITAMINS" → "Health - Vitamins" (matched the mid-breadcrumb
    // Health/Vitamins). This runs EVEN for breadcrumb-confident picks, because the
    // ROOT department is authoritative — a deeper breadcrumb word does NOT change it.
    if (chosen) {
      const bcDept = detectDept((rec.amazonCategoryPath && rec.amazonCategoryPath[0]) || amazonCat);
      const optDepts = allDepts(chosen);   // ALL dept words in the option (e.g. "Apparel - Baby" = {apparel,baby})
      // Mismatch only when the option names department(s) and NONE of them is the
      // breadcrumb's department. So "Apparel - Baby" (contains baby) is KEPT for a
      // baby product, but "Automotive … Gloves" (only automotive) for a Beauty
      // product is dropped.
      if (bcDept && optDepts.size && !optDepts.has(bcDept)) {
        const chDept = [...optDepts].join('/');
        rec.flags.push(`category dept mismatch: "${chosen}" is ${chDept} but product is ${bcDept} — dropped`);
        log(`${asin}: category dept mismatch (${chDept} ≠ ${bcDept}) — dropping "${chosen}"`, 'warn', asin);
        chosen = null; confident = false; source = 'heuristic'; explicitNone = false;
      }
    }

    // UNIVERSAL breadcrumb-support check (user rule 2026-06-11 "it should be
    // universal"): trust a SPECIFIC (non-catch-all) category only if at least one
    // of its words actually appears in the product's breadcrumb. An UNSUPPORTED
    // pick — e.g. a wig → "Beauty - Haircare Bath Shower" (none of haircare/bath/
    // shower are in the breadcrumb), or any "closest" guess for a sub-category the
    // dropdown lacks — is replaced by the department's "<Dept> - Other Products".
    // This catches confident-but-wrong picks WITHOUT any per-product override, and
    // keeps a genuinely supported pick (its words ARE in the breadcrumb).
    if (chosen && !/\bother\b/i.test(chosen)) {
      const bc = breadcrumbWeights(rec.amazonCategoryPath, amazonCat);          // stemmed token→weight
      // Support = a NON-department breadcrumb word matches. Exclude only true dept
      // NAMES (DEPT_CANON[t]===t, e.g. "beauty"/"health"); keep specific leaf words
      // that are also dept SYNONYMS ("haircare"→beauty, "bedding"→home) as support
      // — else "Beauty - Haircare Bath Shower" would look unsupported for a shampoo.
      const supported = tokens(chosen).map(stemTok).some(t => bc.has(t) && DEPT_CANON[t] !== t);
      if (!supported) {
        const alt = mainTagCategory(rec.amazonCategoryPath, amazonCat, options);
        if (alt && norm(alt) !== norm(chosen)) {
          rec.flags.push(`category: "${chosen}" not supported by breadcrumb → "${alt}" (verify)`);
          log(`${asin}: category "${chosen}" not in breadcrumb → ${alt} (dept catch-all)`, 'warn', asin);
          chosen = alt; confident = false; source = 'dept-other';
        }
      }
    }

    rec.categoryConfident = confident; rec.categorySource = source;
    const prefilled = rec._catSelected || '';

    if (!chosen) {
      // No specific match. Try the department's "<Dept> - Other Products" catch-all
      // from the breadcrumb root (unless the LLM said NONE = book/irrelevant).
      const deptOther = explicitNone ? null : mainTagCategory(rec.amazonCategoryPath, amazonCat, options);
      const deptWord = deptOther ? norm(deptOther).split(' ')[0] : '';
      const prefillSameDept = prefilled && deptWord && norm(prefilled).split(' ').includes(deptWord);
      if (deptOther && !(prefilled && prefillSameDept)) {
        // Use the catch-all (overrides a wrong-department pre-fill, or no pre-fill).
        chosen = deptOther; confident = false; source = 'dept-other';
        rec.flags.push(`category → "${deptOther}" (department catch-all — no specific match, verify)`);
        log(`${asin}: category → ${deptOther} (department catch-all)`, 'warn', asin);
        // fall through to select
      } else if (prefilled) {
        // Keep a pre-filled value (correct human entry, or at least same department).
        rec.category = prefilled; rec.flags.push(`category pre-filled "${prefilled}" kept (could not verify a better match)`);
        log(`${asin}: category pre-filled "${prefilled}" — kept`, 'info', asin);
        return;
      } else if (settings.categoryOnNoMatch === 'flag-blank') {
        rec.category = ''; rec.flags.push(explicitNone ? 'category: none fits — left blank (verify)' : 'category: no confident match — left blank');
        log(`${asin}: category → left blank + flagged`, 'warn', asin);
        return;
      } else {
        chosen = categorize(rec.title, rec.brand, options, amazonCat, rec.amazonCategoryPath).category;
        rec.flags.push('category closest-guess (verify)');
      }
    }

    // Cross-verify a pre-filled category: keep it if it already matches our
    // determination; otherwise correct it.
    if (prefilled && norm(prefilled) === norm(chosen)) {
      rec.category = chosen; rec.categoryAlreadyCorrect = true;
      log(`${asin}: category already correct (${chosen}) — kept`, 'ok', asin);
      return;
    }

    rec.category = chosen;
    const sel = await ctx.sendToDashboard({ type: 'SELECT_CATEGORY', asin, category: chosen });
    if (!sel?.ok) {
      rec.flags.push('category select failed: ' + (sel?.error || ''));
      log(`${asin}: category select failed — ${sel?.error}`, 'err', asin);
      if (sel?.cellHtml) { rec.categoryDebugHtml = sel.cellHtml; log(`${asin}: CATEGORY-CELL (copy & send): ${String(sel.cellHtml).slice(0, 600)}`, 'info', asin); }
    }
    else {
      // Show the breadcrumb we mapped from, so a wrong pick is self-diagnosing
      // in the log (leaf-most levels are the signal that should have driven it).
      const bc = (rec.amazonCategoryPath && rec.amazonCategoryPath.length)
        ? rec.amazonCategoryPath.slice(-3).join(' > ') : String(rec.amazonCategory || '').slice(0, 80);
      log(`${asin}: category → ${chosen} (${source}${confident ? '' : ', low-confidence'})${prefilled ? ` [corrected from "${prefilled}"]` : ''} | breadcrumb: ${bc || 'none'}`, confident ? 'ok' : 'warn', asin);
    }
    if (prefilled && norm(prefilled) !== norm(chosen)) rec.flags.push(`category corrected: "${prefilled}" → "${chosen}"`);
    if (!confident) rec.flags.push('category low-confidence (verify)');
  }

  function llmChannelReady(settings) {
    return isWebMode(settings.weightMode) || (settings.weightMode === 'api' && !!settings.llmApiKey);
  }

  // ONE combined call (weight and/or category). `mode` overrides the channel
  // (used for the ChatGPT weight fallback when Gemini fails).
  async function llmAnalyze({ title, brand, amazonCategory, options, needWeight, needCategory, settings, mode }) {
    const m = mode || settings.weightMode;
    if (isWebMode(m)) {
      // Cap the web-UI wait so a stuck/slow chat (or not-signed-in) can't freeze
      // the run — fail fast and fall back (heuristic category / weight flag).
      const text = await askWeb(m, analyzePrompt({ title, brand, amazonCategory, options, needWeight, needCategory }), { timeoutMs: 30000, show: settings.showWorkingTab !== false });
      return parseAnalyze(text, { needWeight, needCategory });
    }
    return analyzeApi({ title, brand, amazonCategory, options, needWeight, needCategory, provider: settings.llmProvider, apiKey: settings.llmApiKey, model: settings.llmModel });
  }

  // The other web channel, used as a backup for the COMPULSORY weight value.
  function fallbackWeightMode(mode) {
    if (mode === 'gemini-web') return 'chatgpt-web';
    if (mode === 'chatgpt-web') return 'gemini-web';
    return 'gemini-web';   // API primary → web backup
  }

  // Match an LLM-returned category string back to an exact option (normalized).
  function matchOption(options, text) {
    const n = v => String(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const t = n(text);
    return options.find(o => n(o) === t) || options.find(o => n(o).includes(t) || t.includes(n(o))) || null;
  }

  async function writeField(asin, field, value, rec) {
    const r = await ctx.sendToDashboard({ type: 'WRITE_FIELD', asin, field, value });
    if (!r?.ok) {
      rec.flags.push(`write ${field} failed: ${r?.error || ''}`);
      log(`${asin}: write ${field} failed — ${r?.error}`, 'err', asin);
      if (r?.cellHtml) { rec[`${field}DebugHtml`] = r.cellHtml; log(`${asin}: ${field.toUpperCase()}-CELL (copy & send): ${String(r.cellHtml).slice(0, 600)}`, 'info', asin); }
    }
    else if (r.corrected) { log(`${asin}: ${field} corrected ${r.prev} → ${value}`, 'ok', asin); rec[`${field}Corrected`] = `${r.prev}→${value}`; }
    return r?.ok;
  }

  // Write the USD price ONLY if amazon.com actually returned dollars. When the
  // browser's amazon.com is set to "Deliver to India" the .com page renders INR,
  // so the scraped "price" is an INR number — writing it into the USD column is
  // wrong. In that case flag the row and leave USD blank.
  // Scrape the .com product; if it comes back in INR (amazon.com reverted to
  // India delivery), set a US ZIP once for the run, reload, and re-scrape so we
  // capture real USD.
  async function scrapeUsa(reloadUrl, settings) {
    let usa = (await tab.rpc({ type: 'SCRAPE_PRODUCT' }))?.data || {};
    if (usa.currency === 'INR' && !s.usZipSet && settings.usZip) {
      s.usZipSet = true; // attempt only once per run
      log(`amazon.com showing INR — setting US ZIP ${settings.usZip} once for this run…`, 'warn');
      try {
        const sr = await tab.rpc({ type: 'SET_US_LOCATION', zip: settings.usZip });
        if (sr?.ok && reloadUrl) {
          await sleep(1200);
          await loadAmazon(reloadUrl, settings);
          await detect();
          const re = (await tab.rpc({ type: 'SCRAPE_PRODUCT' }))?.data;
          if (re) usa = re;
          log(`after US ZIP: .com ${usa.currency} ${usa.priceValue}`, usa.currency === 'USD' ? 'ok' : 'warn');
        } else if (!sr?.ok) { log(`US ZIP set failed: ${sr?.error} — set a US address on amazon.com manually`, 'err'); }
      } catch (e) { if (e.captcha || e.stopped) throw e; log(`US ZIP set error: ${e.message}`, 'err'); }
    }
    return usa;
  }

  // Rescue on Fail: search amazon.com for the SAME product at a cheaper USD —
  // ideally BELOW the India price (maxUsd) so the row becomes profitable. If
  // found, repoint the USA + Source links to it and re-scrape.
  async function rescueCheaperUsa(rec, settings, maxUsd) {
    const query = rec.title;
    if (!query) return false;
    const ceiling = maxUsd != null ? maxUsd : rec.usd;   // must be cheaper than this
    setStep('rescue: cheaper .com search', rec.asin);
    try {
      await loadAmazon(tab.searchUrl(COM_ORIGIN, query), settings);
      await detect();
      const sm = await tab.rpc({ type: 'SEARCH_AND_MATCH', query, brand: rec.brand });
      const cands = (sm?.candidates || []).filter(c => c.confident && c.priceValue != null && c.link && c.currency !== 'INR');
      const cheaper = cands.filter(c => ceiling == null || c.priceValue < ceiling).sort((a, b) => a.priceValue - b.priceValue)[0];
      if (!cheaper) { log(`${rec.asin}: no same-product .com match under $${ceiling != null ? ceiling.toFixed(2) : '∞'} found`, 'info', rec.asin); return false; }
      log(`${rec.asin}: cheaper .com match ${cheaper.asin} $${cheaper.priceValue} (was $${rec.usd}, target < $${ceiling?.toFixed?.(2)}) — repointing USA/Source link`, 'ok', rec.asin);
      await loadAmazon(cheaper.link, settings);
      if (await detect() !== PAGE.PRODUCT) return false;
      const usa = await scrapeUsa(cheaper.link, settings);
      if (usa.currency === 'INR' || usa.priceValue == null) { log(`${rec.asin}: cheaper match unusable (no USD)`, 'warn', rec.asin); return false; }
      const canon = usa.canonicalUrl || cheaper.link;
      rec.usaRescued = canon; rec.bsrUsa = usa.bsrPrimary;
      await ctx.sendToDashboard({ type: 'SET_USA_LINK', asin: rec.asin, url: canon });   // edit the USA LINK cell
      await writeUsd(rec.asin, usa, rec);
      rec.sourceLink = canon; await writeField(rec.asin, 'sourceLink', canon, rec);
      rec.flags.push(`USA rescued → cheaper $${usa.priceValue} (verify)`);
      return true;
    } catch (e) { if (e.captcha || e.stopped) throw e; rec.flags.push('rescue failed: ' + e.message); log(`${rec.asin}: rescue failed — ${e.message}`, 'err', rec.asin); return false; }
  }

  async function writeUsd(asin, usa, rec) {
    if (usa.priceValue == null) { rec.flags.push('USA price not found'); return; }
    if (usa.currency === 'INR') {
      rec.usdRawCurrency = 'INR'; rec.usdRawValue = usa.priceValue;
      rec.flags.push(`USA price came back INR ${usa.priceValue} — amazon.com is delivering to India. Set a US delivery ZIP on amazon.com to capture real USD. USD left blank.`);
      log(`${asin}: .com price is INR (₹${usa.priceValue}), not USD — USD NOT written. Set amazon.com to a US address.`, 'warn', asin);
      return;
    }
    rec.usd = usa.priceValue;
    await writeField(asin, 'usd', usa.priceValue, rec);
  }

  // Funnel RS/DP (user rule 2026-06-10): India BSR < threshold => RS; BSR null
  // OR >= threshold => DP. We CROSS-VERIFY the dashboard's funnel and correct it
  // if it's wrong.
  async function verifyAndFixFunnel(rec, settings) {
    const src = settings.funnelBsrSource || 'india';
    const iu = rec.bsrIndia, uu = rec.bsrUsa;
    let bsr = null;
    if (src === 'india') bsr = iu;        // India BSR only
    else if (src === 'lower') bsr = [iu, uu].filter(v => v != null).sort((a, b) => a - b)[0] ?? null;
    else bsr = (uu != null ? uu : iu);    // 'usa'
    rec.funnelBsrUsed = bsr; rec.funnelBsrSource = src;
    const funnel = (bsr != null && bsr < settings.bsrThreshold) ? 'RS' : 'DP';  // null/≥ => DP
    rec.funnel = funnel;

    const r = await ctx.sendToDashboard({ type: 'SET_FUNNEL', asin: rec.asin, funnel });
    rec.funnelCurrent = r?.current;
    rec.funnelOk = !!r?.ok;
    if (r?.changed) { rec.funnelCorrected = `${r.current || '?'}→${funnel}`; log(`${rec.asin}: funnel corrected ${r.current || '?'} → ${funnel} (India BSR ${bsr ?? 'null'})`, 'ok', rec.asin); }
    else if (r?.ok) { log(`${rec.asin}: funnel ${funnel} already correct (India BSR ${bsr ?? 'null'})`, 'info', rec.asin); }
    else {
      rec.flags.push(`funnel mismatch: shows ${r?.current || '?'}, should be ${funnel} — couldn't change`);
      log(`${rec.asin}: funnel should be ${funnel} but shows ${r?.current || '?'} — couldn't set`, 'warn', rec.asin);
      if (r?.menuHtml) log(`${rec.asin}: FUNNEL-MENU (copy & send): ${String(r.menuHtml).slice(0, 800)}`, 'info', rec.asin);
      else if (r?.cellHtml) log(`${rec.asin}: FUNNEL-CELL (copy & send): ${String(r.cellHtml).slice(0, 600)}`, 'info', rec.asin);
    }
  }

  function shortHost(u) { try { return new URL(u).host; } catch { return String(u).slice(0, 40); } }
  function hostOf(u) { try { return new URL(u).host; } catch { return String(u || ''); } }

  // Rewrite an Amazon URL to the target marketplace, keeping the /dp/ASIN path
  // and query. target: 'in' -> www.amazon.in, 'com' -> www.amazon.com.
  function rewriteAmazonDomain(url, target) {
    try {
      const u = new URL(url);
      u.hostname = (target === 'in') ? 'www.amazon.in' : 'www.amazon.com';
      return u.toString();
    } catch {
      return String(url).replace(/amazon\.(in|com)/i, target === 'in' ? 'amazon.in' : 'amazon.com');
    }
  }

  // The dashboard auto-saves each field and re-renders the row, which can clobber
  // earlier writes (a race). After all writes, re-read the row and RE-WRITE any
  // field that reverted to empty, until everything sticks — so the row is truly
  // complete and "Move Pass" appears.
  async function ensureFieldsStick(asin, rec) {
    const want = {};
    if (rec.weightGrams != null) want.weight = rec.weightGrams;
    if (rec.usd != null) want.usd = rec.usd;
    if (rec.inr != null) want.inr = rec.inr;            // optional, but keep it if we have it
    if (rec.sourceLink) want.sourceLink = rec.sourceLink;
    // VALUE-aware checks (not just non-empty): a cell holding the WRONG number/
    // text must be corrected too, otherwise a mis-written field silently passes.
    const numMatch = (cur, val) => {
      const na = parseFloat(String(cur).replace(/[^0-9.]/g, '')), nb = Number(val);
      return Number.isFinite(na) && Number.isFinite(nb) && (Math.abs(na - nb) < 0.5 || (nb !== 0 && Math.abs(na - nb) / Math.abs(nb) < 0.02));
    };
    const fieldOk = (f, cur) => {
      if (cur == null || String(cur).trim() === '') return false;
      const a = String(cur).trim();
      if (f === 'weight' || f === 'usd' || f === 'inr') return numMatch(a, want[f]);
      if (f === 'sourceLink') { const w = String(want[f]); return a === w || a.includes(asin) || w.includes(a) || a.includes(w); }
      return a === String(want[f]);
    };
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const catOk = cur => { const n = norm(cur); const w = norm(rec.category); return !!n && (n === w || n.includes(w) || w.includes(n)); };
    for (let pass = 0; pass < 3; pass++) {
      const r = await ctx.sendToDashboard({ type: 'READ_ROW_FIELDS', asin });
      if (!r?.ok) return;
      const cur = r.fields || {};
      const wrong = Object.keys(want).filter(f => !fieldOk(f, cur[f]));
      const catWrong = rec.category && !catOk(cur.category);
      // Funnel can revert/re-render after later writes — re-correct if it drifted.
      const funnelWrong = rec.funnel && cur.funnel && String(cur.funnel).toUpperCase() !== String(rec.funnel).toUpperCase();
      if (!wrong.length && !catWrong && !funnelWrong) return;   // everything correct
      for (const f of wrong) { log(`${asin}: ${f} wrong/empty (cell="${cur[f] ?? ''}", want ${want[f]}) — re-writing`, 'warn', asin); await writeField(asin, f, want[f], rec); }
      if (catWrong) { log(`${asin}: category wrong (cell="${cur.category ?? ''}", want "${rec.category}") — re-selecting`, 'warn', asin); await ctx.sendToDashboard({ type: 'SELECT_CATEGORY', asin, category: rec.category }); }
      if (funnelWrong) {
        log(`${asin}: funnel wrong (cell="${cur.funnel}", want ${rec.funnel}) — re-setting`, 'warn', asin);
        const fr = await ctx.sendToDashboard({ type: 'SET_FUNNEL', asin, funnel: rec.funnel });
        rec.funnelOk = !!fr?.ok; if (fr?.current) rec.funnelCurrent = fr.current;
      }
      await sleep(350);
    }
    const r2 = await ctx.sendToDashboard({ type: 'READ_ROW_FIELDS', asin });
    const cur2 = r2?.fields || {};
    const still = Object.keys(want).filter(f => !fieldOk(f, cur2[f]));
    if (rec.category && !catOk(cur2.category)) still.push('category');
    if (rec.funnel && cur2.funnel && String(cur2.funnel).toUpperCase() !== String(rec.funnel).toUpperCase()) still.push('funnel');
    if (still.length) { rec.flags.push('fields not sticking: ' + still.join(', ')); log(`${asin}: fields still wrong after retries: ${still.join(', ')}`, 'err', asin); }
  }

  function finalizeRecord(rec) {
    if (rec.flags.length) s.counters.flagged++;
    s.processed.add(rec.asin);
    s.counters.processed = s.processed.size;
    s.rowRecords[rec.asin] = rec;
    persist();
    emit();
  }

  // ---- page reading --------------------------------------------------------
  // Read the CURRENT live page fresh each time. We never hold a stale snapshot:
  // in live mode rows leave as they're Passed/NF'd and the grid shifts, so the
  // only reliable "next row" is the top unprocessed row of a fresh read.
  async function readPage() {
    let res = await ctx.sendToDashboard({ type: 'READ_PAGE_ROWS' });
    // The grid can be momentarily empty/undetected during a re-render — retry once.
    if (!res?.ok || !(res.rows || []).length) {
      await sleep(700);
      const res2 = await ctx.sendToDashboard({ type: 'READ_PAGE_ROWS' });
      if (res2) res = res2;
    }
    // Refresh pagination (best effort) so the Done check below is accurate.
    const pag = await ctx.sendToDashboard({ type: 'READ_PAGINATION' });
    if (pag?.pagination) { s.page = pag.pagination.page; s.totalPages = pag.pagination.totalPages; }
    // No grid / no rows after a retry is the NORMAL end state when the Main File
    // empties (every row Passed/NF'd). Return an EMPTY page so the loop advances
    // pagination / finishes cleanly — NOT a thrown error that aborts the run.
    if (!res?.ok) { log(`page read: ${res?.error || 'no rows'} — treating as empty (rows may all be processed)`, 'info'); return []; }
    return res.rows || [];
  }

  let lastLoggedPage = null;
  async function runLoop() {
    if (s.loopActive) return;
    s.loopActive = true;
    const myReset = s.resetSeq;
    const settings = await getSettings();
    await syncWorkingWindow();   // put run tabs in the dashboard's window (re-checked per row too)
    try {
      while (!s.stopRequested && !s.pauseRequested && !s.pausedByCaptcha) {
        const rows = await readPage();
        const pending = rows.filter(r => r.asin && !s.processed.has(r.asin));
        const stayed = rows.filter(r => r.asin && s.processed.has(r.asin)).length;   // worked but left in Main File
        const noAsin = rows.filter(r => !r.asin).length;                              // couldn't read an ASIN
        s.queue = pending;
        if (s.page !== lastLoggedPage) { log(`Page ${s.page ?? '?'}: ${rows.length} rows — ${pending.length} to do, ${stayed} done & left in place (no-INR/flagged), ${noAsin} with no ASIN`, 'info'); lastLoggedPage = s.page; }
        emit();

        if (pending.length === 0) {
          // page fully done — advance pagination
          if (noAsin) log(`Page ${s.page}: ${noAsin} row(s) had no readable ASIN and were skipped — tell me if these should be processed`, 'warn');
          log(`Page ${s.page} complete — ${stayed} row(s) left in Main File (no-INR / flagged / dashboard-fail-that-stays); advancing`, 'info');
          if (s.totalPages && s.page && s.page >= s.totalPages) { s.status = 'Done — all pages processed'; break; }
          setStep('next page');
          const before = s.page;
          const np = await ctx.sendToDashboard({ type: 'GOTO_NEXT_PAGE' });
          if (!np?.ok) { s.status = np?.lastPage ? 'Done — last page' : 'Stopped — pagination: ' + (np?.error || ''); break; }
          await sleep(900); // let the grid re-render
          await readPage();
          if (s.page === before) { s.status = 'Done — pagination did not advance'; break; } // guard vs infinite loop
          continue;
        }

        // Always process the TOP unprocessed row of the fresh read.
        const row = pending[0];
        try {
          await processRow(row, settings);
        } catch (e) {
          if (e.captcha) { return; }      // paused for human; resume() re-enters
          if (e.stopped) { break; }        // stop/pause requested mid-row
          // unexpected error — flag the row (so it's skipped next read), keep going
          log(`${row.asin}: row error — ${e.message}`, 'err', row.asin);
          const rec = s.rowRecords[row.asin] || { asin: row.asin, flags: [] };
          rec.flags = (rec.flags || []).concat('row error: ' + e.message); rec.branch = 'error';
          finalizeRecord(rec);
        }
      }
    } catch (e) {
      if (e.captcha) { /* paused for human; status already set in detect() */ }
      else if (e.stopped) { /* stop/pause requested; handled in finally */ }
      else { s.status = 'Error: ' + e.message; log(`Run error: ${e.message}`, 'err'); }
    } finally {
      s.loopActive = false;
      // A reset happened while we were running — it already cleared state; don't
      // override its 'Idle' status or touch anything.
      if (s.resetSeq !== myReset) { return; }
      s.running = false;
      if (s.stopRequested) s.status = s.status.startsWith('Done') ? s.status : 'Stopped';
      else if (s.pausedByCaptcha) { s.paused = true; /* keep captcha status */ }
      else if (s.pauseRequested || s.paused) { s.paused = true; if (!s.status.startsWith('Paused')) s.status = 'Paused'; }
      // Close the managed Amazon + LLM tabs when the run is truly over (done,
      // stopped, or errored) — but keep them open for a CAPTCHA/pause resume.
      if (!s.pausedByCaptcha && !s.pauseRequested && !s.paused) {
        s.active = false;   // truly over (done/stopped/error) — no auto-resume next launch
        highlight(null);  // clear the active-row highlight on the dashboard
        try { await tab.closeTab(); } catch {}
        try { await closeLlmTab(); } catch {}
        log('Run finished — closed Amazon + LLM tabs', 'info');
      }
      try { chrome.power?.releaseKeepAwake?.(); } catch {}
      persist(); emit();
    }
  }

  // ---- public control -------------------------------------------------------
  // Stop any in-flight loop and WAIT for it to fully exit before a new run/reset,
  // so we never have two loops racing on the dashboard (the TEST000000 bug).
  async function stopAndWait() {
    if (!s.loopActive && !s.running) return;
    s.stopRequested = true; s.pauseRequested = false;
    try { await tab.closeTab(); } catch {}     // aborts an in-flight rpc → loop unblocks fast
    try { await closeLlmTab(); } catch {}
    for (let i = 0; i < 60 && s.loopActive; i++) await sleep(200);   // wait up to ~12s
  }

  async function start() {
    await hydrated;
    await stopAndWait();                        // guarantee no concurrent loop
    const settings = await getSettings();
    // Fresh pass: clear the processed-set/counters/records so Start covers EVERY
    // ASIN from the top of the CURRENT page (no jump to page 1). It does not
    // clear the visible log. Use Resume (CAPTCHA) to continue without clearing.
    s.processed = new Set(); s.rowRecords = {}; s.queue = [];
    s.counters = { processed: 0, passed: 0, failed: 0, linkNf: 0, usaLinkNf: 0, flagged: 0 };
    await chrome.storage.local.remove([K.PROCESSED, K.COUNTERS, K.ROW_RECORDS]).catch(() => {});
    s.stopRequested = false; s.pauseRequested = false; s.paused = false; s.pausedByCaptcha = false;
    s.active = true;         // mark in-flight so a crash/restart auto-resumes
    s.running = true; s.status = settings.dryRun ? 'Running (dry-run)' : 'Running';
    s.usZipSet = false;      // re-verify .com is USD at the start of each run
    lastLoggedPage = null;   // so the first page logs after a restart
    try { chrome.power?.requestKeepAwake?.('display'); } catch {}
    persist();               // save active=true now so a crash in row 1 still resumes
    emit();
    runLoop();
    return { ok: true };
  }
  async function resume() {
    await hydrated;
    if (s.running) return { ok: false, error: 'already running' };
    s.pausedByCaptcha = false; s.paused = false; s.pauseRequested = false; s.stopRequested = false;
    s.active = true;         // in-flight again (also covers auto-resume after a crash)
    const settings = await getSettings();
    s.running = true; s.status = settings.dryRun ? 'Running (dry-run)' : 'Running';
    persist();               // save active=true promptly
    emit();
    runLoop();
    return { ok: true };
  }
  function pause() {
    if (!s.running) return { ok: false, error: 'not running' };
    s.pauseRequested = true;
    s.active = false;        // intentional pause — do NOT auto-resume on restart
    s.status = 'Pausing… (finishing current step)';
    persist(); emit();
    return { ok: true };
  }
  async function stop() {
    s.stopRequested = true; s.pauseRequested = false;
    s.active = false;        // intentional stop — do NOT auto-resume on restart
    highlight(null);  // clear the row highlight
    await tab.closeTab();
    await closeLlmTab();
    s.running = false; s.status = 'Stopped';
    persist(); emit();
    return { ok: true };
  }
  async function reset() {
    // Stop any active run and WAIT for it to exit, then wipe everything.
    s.resetSeq++;                       // tell any in-flight loop to stand down
    await stopAndWait();
    try { highlight(null); } catch {}
    s.running = false; s.loopActive = false; s.active = false;
    // Wipe ALL state.
    s.processed = new Set(); s.rowRecords = {}; s.queue = [];
    s.counters = { processed: 0, passed: 0, failed: 0, linkNf: 0, usaLinkNf: 0, flagged: 0 };
    s.status = 'Idle'; s.page = null; s.totalPages = null; s.currentAsin = null; s.step = '';
    s.paused = false; s.pausedByCaptcha = false; s.usZipSet = false;
    lastLoggedPage = null;
    await chrome.storage.local.remove([K.PROCESSED, K.COUNTERS, K.ROW_RECORDS, K.RUN_STATE]);
    emit();
    return { ok: true };
  }

  function getStatus() {
    return {
      running: s.running, paused: s.paused, pausedByCaptcha: s.pausedByCaptcha,
      status: s.status, currentAsin: s.currentAsin, step: s.step,
      page: s.page, totalPages: s.totalPages, queueRemaining: s.queue.length,
      counters: s.counters, processedCount: s.processed.size,
    };
  }
  function getRecords() { return Object.values(s.rowRecords); }

  // Manually close the managed Amazon + LLM tabs. If a run is active, STOP it
  // first — otherwise the loop would immediately reopen a tab on its next step.
  async function closeTabs() {
    await stopAndWait();                 // stops the loop + closes tabs + waits
    s.running = false;
    if (!s.status.startsWith('Done') && !s.pausedByCaptcha) s.status = 'Stopped';
    try { highlight(null); } catch {}
    try { await tab.closeTab(); } catch {}
    try { await closeLlmTab(); } catch {}
    persist(); emit();
    log('Closed Amazon + LLM tabs', 'info');
    return { ok: true };
  }

  // True when a run was in-flight and got interrupted (crash/restart) rather than
  // gracefully stopped/paused — the background auto-resume checks this on launch.
  function wantsResume() { return s.active && !s.running && !s.loopActive; }

  return { start, pause, resume, stop, reset, getStatus, getRecords, closeTabs, wantsResume, hydrated };
}

// ----------------------------------------------------------------------------
// Category mapping (spec §7). Reads the dashboard's actual option list at
// runtime; maps product -> best option by token overlap of brand+title against
// the option label. "confident" requires a non-trivial overlap. Editable: tweak
// CATEGORY_KEYWORDS to bias specific categories.
// ----------------------------------------------------------------------------
const CATEGORY_KEYWORDS = {
  // example bias entries — extend as needed:
  // 'Supplements': ['capsule', 'tablet', 'softgel', 'vitamin', 'omega', 'protein', 'mg'],
  // 'Skin Care': ['cream', 'serum', 'lotion', 'moisturizer', 'spf'],
};
// Stop words for category matching. Includes GENERIC connector/quantity words
// ("accessories", "supplies", "set", "kit", "pack"…) that appear across many
// unrelated categories — letting them match causes false picks (a hair towel
// under "Hair Styling ACCESSORIES" wrongly matching "Water Heaters and
// ACCESSORIES"). Removing them forces matching on the MEANINGFUL product words.
// NB: the override + dept-catch-all resolvers tokenize labels themselves (raw
// split), so "other"/"products" still work there.
const CAT_STOP = new Set([
  'and', 'for', 'the', 'with', 'all', 'new', 'other', 'amazon', 'store', 'kindle', 'books',
  'accessory', 'accessories', 'supply', 'supplies', 'product', 'products', 'item', 'items',
  'set', 'sets', 'kit', 'kits', 'pack', 'packs', 'piece', 'pieces', 'assorted', 'count',
  'pcs', 'general', 'misc', 'miscellaneous', 'universal',
]);
function tokens(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !CAT_STOP.has(w)); }
// Light singular/plural stem so a sub-category in the breadcrumb maps to its
// dropdown option despite plural/singular differences ("Craft"↔"Crafts",
// "Diaper"↔"Diapers", "Glove"↔"Gloves", "Vitamin"↔"Vitamins", "Accessories"↔
// "Accessory"). Applied to BOTH sides during category matching, so the stem need
// not be a real word — only consistent. NOT used by detectDept (dept keys stay literal).
function stemTok(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
// Concatenate ADJACENT tokens so a SMASHED dropdown word matches a SPACED
// breadcrumb (the Amazon tree): "Hair Care" → also "haircare" (matches the
// "Beauty - Haircare Bath Shower" option), "Body Wash" → "bodywash", "Bed Sheet"
// → "bedsheet". The concat need not be a real word — only consistent both sides.
function withBigrams(toks) {
  const out = toks.slice();
  for (let i = 0; i + 1 < toks.length; i++) out.push(toks[i] + toks[i + 1]);
  return out;
}
// "Closest" match between the dashboard options and the product. The Amazon
// breadcrumb (amazonCategory) is the strongest signal (weight 5); title/brand
// are weak (weight 1) so an incidental word like "baby" in a novel title can't
// outvote the real Amazon category.
// Curated category OVERRIDES (user-specified). Highest priority — beats the
// heuristic AND the LLM. Each rule: a product-type keyword regex → target words
// that are matched against the LIVE option list by WHOLE-WORD containment, so
// the exact label/punctuation doesn't matter ("Beauty - Other" / "Beauty Other"
// both resolve from target ['beauty','other']). Extend as the user specifies
// more mappings (e.g. incontinence/underpad → its correct option).
const CATEGORY_OVERRIDES = [
  // Wigs / hair extensions / wig caps → the Beauty catch-all (user 2026-06-11).
  { re: /\b(wig|wigs|wig\s*cap|wig\s*caps|hair\s*piece|hairpiece|hair\s*extensions?)\b/i, target: ['beauty', 'other'] },
  // Diaper PAIL / BAGS / SACKS / disposal / refill — diaper ACCESSORIES, NOT
  // diapers themselves — → Baby catch-all (user 2026-06-11). The diaper/nappy
  // prefix is required so plain "Baby Diapers" or generic "refill rolls" don't match.
  { re: /\b(?:diapers?|nappy|nappies)\s*(?:pail|bags?|sacks?|disposal|refill)\b/i, target: ['baby', 'other'] },
  // BATTERIES — Amazon.in often mis-files batteries under Health/Home, so the
  // breadcrumb is unreliable; the TITLE is the real signal. Require a battery
  // SPEC word (volt/SLA/AGM/AH/lithium/rechargeable…) so "battery charger/case"
  // and incidental "battery" mentions don't match. User (2026-06-11): batteries
  // → the Automotive CATCH-ALL "Automotive - Other Products" (not the batteries bucket).
  { re: /(?=.*\bbatter(?:y|ies)\b)(?=.*\b(?:volt|sla|agm|lead[\s-]?acid|lithium|li-?ion|ni-?mh|\d+\s*v\b|\d+\s*ah\b|\d+\s*mah\b)\b)(?!.*\b(?:charger|chargers|case|cases|holder|tester|organizer|cable|cables|terminal|clip|clips|box|monitor|powered|operated|fans?|toothbrush|shaver|trimmer|lamp|lights?|torch|flashlight|toys?|speaker|radio|clock|watch|drill|mower|pump|heater)\b)/i, target: ['automotive', 'other'] },
  // Microscopes (scientific instruments) — the breadcrumb "Binoculars/Telescopes/
  // Optics > Microscopes" otherwise scatters them to USB Flash Drives / Projectors
  // / blank. → the scientific bucket (user 2026-06-11).
  { re: /\bmicroscopes?\b/i, target: ['business', 'scientific'] },
];

// Product types with NO clean specific dropdown option → always route to the
// product's OWN department's "<Dept> - Other Products" (user rule 2026-06-11
// "check their main tag … use Other"). Resolved per-row from the breadcrumb root,
// so a HOME cleaning cloth → Home-Other but a CAR one → Automotive-Other. Cleaning
// CONSUMABLES only (cloth/wipe/mop/duster/sponge) — NOT appliances (vacuums) nor a
// "microfiber HAIR towel" (which stays Beauty).
const FORCE_DEPT_CATCHALL_RE = /\b(?:microfiber|cleaning|kitchen|dish|scrub)\s+(?:cloth|cloths|wipe|wipes|rag|rags|sponge|sponges)\b|\bcleaning\s+(?:cloth|wipe|rag)\b|\b(?:mop|mops|squeegee|squeegees|duster|dusters|scrubber|scrubbers)\b/i;
function categoryOverride(title, amazonCategory, options) {
  const hay = `${title || ''} ${amazonCategory || ''}`;
  for (const o of CATEGORY_OVERRIDES) {
    if (!o.re.test(hay)) continue;
    const opt = (options || []).find(op => {
      const ws = new Set(String(op).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));
      return o.target.every(t => ws.has(t));
    });
    if (opt) return opt;   // resolved to a real option in the live list
  }
  return null;
}

// Canonical DEPARTMENT of a breadcrumb root or a category label. Maps Amazon's
// many top-level names to the dashboard's department word (e.g. Clothing→apparel,
// Household→health, Kitchen→home). Used to (a) find the right "<Dept> - Other
// Products" catch-all and (b) reject a cross-department category (a Beauty
// product must never be "Automotive …").
const DEPT_CANON = {
  beauty: 'beauty', baby: 'baby', automotive: 'automotive', car: 'automotive', vehicle: 'automotive',
  health: 'health', healthcare: 'health', household: 'health', medical: 'health', personal: '',
  pet: 'pet', grocery: 'grocery', gourmet: 'grocery',
  home: 'home', kitchen: 'home', furniture: 'home', electronics: 'electronics', electronic: 'electronics',
  computer: 'electronics', computers: 'electronics', toys: 'toys', toy: 'toys', sports: 'sports', sport: 'sports',
  outdoors: 'sports', office: 'office', garden: 'garden', patio: 'garden', tools: 'tools',
  industrial: 'business', business: 'business', scientific: 'business', clothing: 'apparel',
  apparel: 'apparel', shoes: 'apparel', fashion: 'apparel', luggage: 'luggage', jewelry: 'jewelry',
  books: 'books', music: 'music', musical: 'music',
  // Camera is an Amazon sub-department of Electronics — keep them the SAME family
  // so "Camera Accessories"/"Camera Lenses" aren't dropped under an Electronics
  // breadcrumb (and vice-versa).
  camera: 'electronics', camcorder: 'electronics', photo: 'electronics',
  // Synonyms / smashed forms so EVERY department matches across Amazon-root vs
  // dashboard-prefix spelling (bigrams like "haircare"/"homecare" resolve too).
  cosmetics: 'beauty', cosmetic: 'beauty', makeup: 'beauty', skincare: 'beauty', haircare: 'beauty',
  fragrance: 'beauty', grooming: 'beauty',
  motorbike: 'automotive', motorcycle: 'automotive',
  footwear: 'apparel', clothes: 'apparel', garment: 'apparel', jewellery: 'jewelry',
  // NB: only "mobiles" (the Amazon dept), NOT "mobile" — "Mobile Home" must stay home.
  mobiles: 'electronics', computing: 'electronics',
  homecare: 'home', kitchenware: 'home', cookware: 'home', furnishing: 'home', furnishings: 'home',
  decor: 'home', bedding: 'home', appliance: 'home', appliances: 'home',
  beverage: 'grocery', beverages: 'grocery', snacks: 'grocery', pantry: 'grocery',
  pets: 'pet', petcare: 'pet', stationery: 'office',
  commercial: 'business', laboratory: 'business',
  // NB: dropped "hardware"→tools (Networking/Computer Hardware are electronics) and
  // "instruments"→music (Surgical/Lab Instruments); "musical" already covers music.
};
// Drop anything after "excl"/"excluding"/"except" — those words name what the
// category EXCLUDES (e.g. "Electronic Devices excl TV Camera"), so they must NOT
// count toward the department ("Camera" there is excluded, not the department).
function deptText(text) { return String(text || '').replace(/\b(?:excl\.?|excluding|excludes?|except)\b[\s\S]*$/i, ''); }
// withBigrams so a SMASHED dashboard/Amazon dept word matches a SPACED one for
// EVERY department: "Health Care"→"healthcare", "Home Care"→"homecare", "Hair
// Care"→"haircare", "Make Up"→"makeup". Single tokens are checked first (so the
// primary/root dept wins), then the concatenations.
function detectDept(text) {
  for (const w of withBigrams(tokens(deptText(text)))) { if (Object.prototype.hasOwnProperty.call(DEPT_CANON, w) && DEPT_CANON[w]) return DEPT_CANON[w]; }
  return '';
}
// ALL canonical departments named in a label (e.g. "Apparel - Baby" → {apparel,
// baby}). Used by the dept-guard so a cross-listed option isn't wrongly dropped.
function allDepts(text) {
  const out = new Set();
  for (const w of withBigrams(tokens(deptText(text)))) { const c = DEPT_CANON[w]; if (c) out.add(c); }
  return out;
}

// The dashboard list has a "<Department> - Other Products" catch-all per
// department (Apparel/Automotive/Baby/Beauty/… confirmed in the live Scan).
// When NOTHING specific matches, fall back to the department's catch-all using
// the breadcrumb's ROOT department (canonicalised, so Clothing→apparel works).
// Returns null if there's no matching catch-all in the live list (then we flag).
function departmentOtherOption(amazonPath, amazonCategory, options) {
  const root = (amazonPath && amazonPath.length) ? amazonPath[0]
    : String(amazonCategory || '').split('|')[0].split('>')[0];
  const dept = detectDept(root) || (tokens(root)[0] || '').toLowerCase();   // "beauty"/"apparel"/"health"…
  if (!dept) return null;
  return (options || []).find(op => {
    const ws = new Set(String(op).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));
    // "other" catch-all whose department == the breadcrumb root's — matched by the
    // literal dept word OR its canonical dept, so "Healthcare - Other" resolves for
    // a "health"-root product even though the option says "Healthcare" not "Health".
    return ws.has('other') && (ws.has(dept) || detectDept(op) === dept);
  }) || null;
}

// The dropdown option that IS the breadcrumb's ROOT tag (user rule 2026-06-11
// "use the main tag, e.g. Home Improvement") — an EXACT word-set match, so root
// "Home Improvement" → the "Home Improvement" option, but NOT the longer/specific
// "Home Improvement Kitchen Bath Fittings". ("X - Other Products" reduces to {X}
// after stopwords, so a single-word root still resolves to its catch-all here.)
function rootTagOption(amazonPath, amazonCategory, options) {
  const root = (amazonPath && amazonPath.length) ? amazonPath[0]
    : String(amazonCategory || '').split('|')[0].split('>')[0];
  const rootToks = tokens(root).map(stemTok);
  if (!rootToks.length) return null;
  const rootSet = new Set(rootToks);
  return (options || []).find(op => {
    const ws = new Set(tokens(op).map(stemTok));
    return ws.size === rootSet.size && [...rootSet].every(t => ws.has(t));
  }) || null;
}
// "Main tag" category for a no-specific-match product: the root-tag option if one
// exists (e.g. "Home Improvement"), else the "<Dept> - Other Products" catch-all.
function mainTagCategory(amazonPath, amazonCategory, options) {
  return rootTagOption(amazonPath, amazonCategory, options) || departmentOtherOption(amazonPath, amazonCategory, options);
}

// Weight breadcrumb tokens by DEPTH: the leaf (most specific, e.g. "Disposable
// Underpads") far outweighs the root department ("Health"), so a generic
// department word can't win a category on its own. Secondary signals (BSR "in X"
// categories, department nav) get a low flat weight. Returns Map<token, weight>.
function breadcrumbWeights(amazonPath, amazonCategory) {
  const w = new Map();
  const bump = (t, weight) => { if (weight > (w.get(t) || 0)) w.set(t, weight); };
  for (const t of tokens(amazonCategory)) bump(stemTok(t), 2);        // secondary, flat
  const levels = (amazonPath && amazonPath.length) ? amazonPath
    : String(amazonCategory || '').split('|')[0].split('>');
  const n = levels.length;
  levels.forEach((lvl, i) => {
    // STEEP: the leaf (the actual product type, e.g. "Headphones"/"Skins") far
    // outweighs shallow generic levels ("Electronics"/"Accessories"), so a specific
    // option wins over a generic one that only matches the department.
    const weight = 2 + Math.round((i / Math.max(1, n - 1)) * 10);     // root 2 → leaf 12
    for (const t of withBigrams(tokens(lvl).map(stemTok))) bump(t, weight);
  });
  return w;
}

function categorize(title, brand, options, amazonCategory, amazonPath) {
  const catWeights = breadcrumbWeights(amazonPath, amazonCategory);
  const weakTokens = new Set(tokens(title).concat(tokens(brand)).map(stemTok));
  let best = null, bestScore = 0, bestViaAmazon = false, bestAmazonMatches = 0, bestOptTokens = 0, bestMaxW = 0;
  for (const opt of options) {
    if (/select|choose|^--/i.test(opt)) continue;
    const optToks = tokens(opt).map(stemTok);
    let score = 0, fromAmazon = false, amazonMatches = 0, maxW = 0;
    for (const w of optToks) {
      const bw = catWeights.get(w);
      if (bw) { score += bw; fromAmazon = true; amazonMatches++; if (bw > maxW) maxW = bw; }  // breadcrumb word (depth-weighted)
      else if (weakTokens.has(w)) score += 1;                                                  // title/brand word (weak)
    }
    for (const w of (CATEGORY_KEYWORDS[opt] || [])) { const sw = stemTok(w); if (catWeights.has(sw)) score += 3; else if (weakTokens.has(sw)) score += 1; }
    if (score > bestScore) { bestScore = score; best = opt; bestViaAmazon = fromAmazon; bestAmazonMatches = amazonMatches; bestOptTokens = optToks.length; bestMaxW = maxW; }
  }
  // Confident when the breadcrumb drove a SPECIFIC match — ≥2 of the option's
  // words in the breadcrumb, OR the WHOLE option name, OR a strong LEAF match
  // (`bestMaxW >= 8` = the option contains the breadcrumb's product-type word like
  // "Headphones"/"Skins", even if its other words aren't in the breadcrumb). A
  // lone SHALLOW/department word ("Health", "Electronics", weight ≤ ~5) is NOT
  // confident → defer to the LLM / dept catch-all rather than force a wrong category.
  const confident = bestViaAmazon && bestOptTokens > 0 &&
    (bestAmazonMatches >= 2 || bestAmazonMatches === bestOptTokens || bestMaxW >= 7);
  return {
    category: best || (options.find(o => !/select|choose|^--/i.test(o)) || options[0]),
    confident,
    viaAmazon: bestViaAmazon,
    score: bestScore,
  };
}

// ----------------------------------------------------------------------------
// Weight reconciliation (user rule REVISED 2026-06-11 "accurate result"). The
// Amazon-listed weight is REAL measured data (the seller/manufacturer "Item
// Weight") and is TRUSTED. The LLM estimate is only a guess from the title, so
// it does NOT override a plausible Amazon value — it only:
//   • fills in a MISSING Amazon weight, or
//   • replaces a PHYSICALLY IMPOSSIBLE one (lighter than its own liquid contents,
//     e.g. 1 g for a 4 ml glass bottle — the original motivating case).
// When Amazon is plausible but the LLM strongly disagrees, we KEEP Amazon and
// FLAG it for a human spot-check (never overwrite measured data with a guess).
// Returns { grams, source, confidence } — grams may be null if both are missing.
function reconcileWeight(amazonGrams, amazonRaw, llmGrams, llmConf, title, rec, settings) {
  const TOL = Number(settings.weightTolerance) > 1 ? Number(settings.weightTolerance) : 2.0; // "agree" within this factor
  const floor = volumeFloorGrams(title); // min plausible content mass in g, or 0
  if (!(amazonGrams > 0)) amazonGrams = null;   // 0 / NaN / negative = no usable weight
  if (!(llmGrams > 0)) llmGrams = null;
  const impossible = amazonGrams != null && floor && amazonGrams < floor;

  // Amazon weight missing → use the LLM estimate (flagged as an estimate).
  if (amazonGrams == null) {
    if (llmGrams == null) return { grams: null, source: null, confidence: null };
    if (llmConf !== 'high') rec.flags.push(`weight LLM ${llmConf} (verify)`);
    return { grams: llmGrams, source: 'llm:' + settings.weightMode, confidence: llmConf };
  }

  // Amazon weight is physically impossible (below its own liquid volume) → it's
  // provably wrong; replace with the LLM estimate (or just flag if no LLM).
  if (impossible) {
    if (llmGrams == null) {
      rec.flags.push(`weight IMPOSSIBLE: Amazon ${amazonGrams}g < ~${floor}g of contents — no LLM to correct (verify)`);
      return { grams: amazonGrams, source: rec.weightSource || 'amazon', confidence: null };
    }
    rec.flags.push(`weight corrected ${amazonGrams}g→${llmGrams}g (Amazon below ~${floor}g of contents${amazonRaw ? `, listed "${amazonRaw}"` : ''})`);
    if (llmConf !== 'high') rec.flags.push(`weight LLM ${llmConf} (verify)`);
    return { grams: llmGrams, source: `llm:${settings.weightMode} (amazon ${amazonGrams}g impossible)`, confidence: llmConf };
  }

  // Amazon weight is plausible → TRUST IT (real measured data). If the LLM guess
  // diverges a lot, flag for review but do NOT overwrite the real value.
  if (llmGrams != null) {
    const ratio = Math.max(amazonGrams, llmGrams) / Math.min(amazonGrams, llmGrams);
    if (ratio > TOL) {
      rec.flags.push(`weight check: Amazon ${amazonGrams}g vs LLM est ${llmGrams}g (${ratio.toFixed(1)}× diff) — kept Amazon, verify`);
      return { grams: amazonGrams, source: 'amazon (LLM differs — review)', confidence: 'medium' };
    }
    return { grams: amazonGrams, source: 'amazon (verified)', confidence: 'high' }; // corroborated
  }
  // No LLM signal, Amazon plausible → just use Amazon.
  return { grams: amazonGrams, source: rec.weightSource || 'amazon', confidence: null };
}

// Parse a liquid/volume from the title and return the minimum plausible content
// mass in grams (~1 g per ml; 1 fl oz ≈ 29.6 ml). Returns 0 when no volume is
// found. Container weight is intentionally ignored — it only makes the true floor
// higher, so anything below this is already physically impossible.
// Digital / weightless products (Kindle eBooks, audiobooks, digital downloads,
// software/app/music/video downloads) have NO physical weight → 0 is CORRECT, so
// don't estimate or flag them. NB: "eBook" is excluded when followed by "reader"
// so a physical Kindle/eBook-READER accessory (case/skin/charger) is NOT matched;
// and the caller also gates on "no Amazon weight" so anything with a real weight
// (a physical book, a Kindle skin) is treated as physical regardless.
const WEIGHTLESS_RE = /\b(kindle\s*edition|audible|audiobooks?(?!\s*(?:player|cd|dvd|disc|cassette))|e-?books?(?!\s*reader)|digital\s*(?:download|copy|code|content|edition)|software\s*download|app\s*download|mp3\s*download)\b/i;
function isWeightlessProduct(title, amazonCategory) {
  return WEIGHTLESS_RE.test(`${title || ''} ${amazonCategory || ''}`);
}

function volumeFloorGrams(title) {
  if (!title) return 0;
  const t = String(title).toLowerCase();
  // ONLY for LIQUID products that ship FULL (volume ≈ shipped content mass, e.g. a
  // 4 ml perfume). An EMPTY capacity-labeled vessel states its capacity, NOT content
  // ("1 Litre Water Bottle" weighs ~150 g, not 1000 g) — so require a liquid word,
  // else no floor (never overwrite a correct measured vessel weight).
  if (!/\b(perfume|cologne|fragrance|eau\s*de|attar|oils?|serum|essence|lotion|creams?|gels?|shampoos?|conditioners?|body\s*wash|face\s*wash|hand\s*wash|sanitiz\w+|sanitis\w+|juice|syrup|sauce|honey|soaps?|cleanser|toner|mist|sprays?|liquid|inks?|paints?|remover|solution|tincture|drops|elixir|balm|moisturiz\w+|moisturis\w+)\b/i.test(t)) return 0;
  let ml = 0, m;
  // NB: no bare "cc" — automotive/bike titles use it for engine displacement
  // ("150 cc"), not liquid volume, which would invent a bogus floor.
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:ml|milli\s?-?\s?lit(?:re|er)s?)\b/))) ml = parseFloat(m[1]);
  // Liters: require an EXPLICIT liter word — never a bare "L"/"lt", which collides
  // with clothing/shoe sizes ("Size 2 L") and would invent a bogus volume floor.
  else if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:ltr|litre|liter|litres|liters)\b/))) ml = parseFloat(m[1]) * 1000;
  else if ((m = t.match(/(\d+(?:\.\d+)?)\s*fl\.?\s*oz\b/))) ml = parseFloat(m[1]) * 29.5735;
  return Number.isFinite(ml) && ml > 0 ? Math.round(ml) : 0;
}
