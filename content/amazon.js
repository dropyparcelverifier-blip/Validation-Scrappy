// content/amazon.js — content script on amazon.in/* and amazon.com/*
//
// Reports facts to the service worker; never decides workflow. RPCs:
//   DETECT_PAGE_TYPE -> product | not_found | unavailable | captcha | other
//   SCRAPE_PRODUCT   -> { bsrPrimary, weightGrams, weightRaw, priceValue,
//                         currency, canonicalUrl, title, asin }
//   SEARCH_AND_MATCH -> (Phase 4) search + §6 three-check match. Stubbed here.
//
// Parsing follows spec §4 precisely, including every oz/ounce spelling and the
// superscript-cents USD case (9`99 -> 9.99).

(function () {
  if (window.__davAmazonReady) return;
  window.__davAmazonReady = true;

  const clip = (s, n) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n || 100000);
  const DP_RE = /\/(?:dp|gp\/product|d|product)\/([A-Z0-9]{10})/i;

  function log(text, kind) {
    try { chrome.runtime.sendMessage({ action: 'logFromContent', source: 'amazon', text, kind }).catch(() => {}); } catch {}
  }

  // =========================== Page-type detection ==========================
  function detectPageType() {
    const url = location.href;
    const bodyText = (document.body?.innerText || '');

    // CAPTCHA / bot-wall — must be checked first; these pages can otherwise look
    // like "other".
    if (
      /\/errors\/validateCaptcha/i.test(url) ||
      document.querySelector('form[action*="validateCaptcha"], #captchacharacters, img[src*="captcha"]') ||
      /enter the characters you see|type the characters|not a robot|to discuss automated access|api-services-support@amazon/i.test(bodyText)
    ) {
      return 'captcha';
    }

    // Dog / 404 page — STRONG signals only (checked before product so a 404
    // never reads as product, but product detection is broad to avoid false NF).
    if (
      /\/errors\//i.test(url) ||
      document.querySelector('img[src*="/dogs/"]') ||
      /sorry! we couldn.?t find that page|the web address you entered is not a functioning page|we're sorry\. the web address you entered/i.test(bodyText)
    ) {
      return 'not_found';
    }

    // Product page — BROAD positive signal (many anchors) so a valid product
    // that's still hydrating isn't misread as not-found. A real product page is
    // ALWAYS 'product', even if it's "currently unavailable" or has no price —
    // we still scrape weight/BSR and fill the other fields (user rule 2026-06-10).
    if (
      document.querySelector(
        '#productTitle, #title, #titleSection, #dp, #ppd, #centerCol #title, [data-feature-name="title"], ' +
        '#add-to-cart-button, #buy-now-button, #buybox, #desktop_buybox, #feature-bullets, ' +
        '#dp-container, #averageCustomerReviews, [data-asin][data-component-type="s-product-image"]'
      ) ||
      (DP_RE.test(url) && document.querySelector('#nav-belt') && bodyText.length > 1500)
    ) {
      return 'product';
    }

    // "Currently unavailable" with NO product shell = effectively dead.
    if (/currently unavailable|this item is not available|no longer available/i.test(bodyText)) {
      return 'unavailable';
    }

    return 'other';
  }

  // ============================== Scraping ==================================
  function scrapeProduct() {
    const title = clip(document.querySelector('#productTitle')?.textContent, 500);
    const pairs = getDetailPairs();
    const asin = extractAsin();

    const cat = getCategoryHints(pairs);
    return {
      title,
      asin,
      bsrPrimary: parseBsr(pairs),
      categoryPath: cat.path,          // breadcrumb array, e.g. ['Electronics','GPS…','Golf Course GPS Units']
      categoryText: cat.text,          // joined breadcrumb + rank categories
      ...parseWeight(pairs),           // { weightGrams, weightRaw, weightSource:'amazon'|null }
      ...parsePrice(),                 // { priceValue, currency, priceRaw }
      canonicalUrl: getCanonicalUrl(asin),
    };
  }

  // Amazon's own category signal: the wayfinding breadcrumb (best), plus the
  // category names from Best Sellers Rank and the department nav as fallback.
  function getCategoryHints(pairs) {
    const path = [];
    const bc = document.querySelector('#wayfinding-breadcrumbs_feature_div, #wayfinding-breadcrumbs_container');
    if (bc) bc.querySelectorAll('a, .a-list-item').forEach(a => { const t = clip(a.textContent, 60); if (t && !path.includes(t)) path.push(t); });

    const rankCats = [];
    const bsrPair = pairs.find(x => /best\s*sellers?\s*rank/i.test(x.label));
    const bsrText = bsrPair ? bsrPair.value : (Array.from(document.querySelectorAll('li, tr')).find(el => /best\s*sellers?\s*rank/i.test(el.textContent || ''))?.textContent || '');
    // capture "in <Category>" names
    const re = /in\s+([A-Za-z][A-Za-z0-9 &',\/-]{2,50})(?=\s*\(|\s*#|$|,)/g;
    let m; while ((m = re.exec(bsrText)) && rankCats.length < 4) { const c = m[1].trim(); if (c && !rankCats.includes(c)) rankCats.push(c); }

    // department fallback
    const dept = document.querySelector('#nav-subnav')?.getAttribute('data-category');
    const text = [path.join(' > '), rankCats.join(' / '), dept || ''].filter(Boolean).join(' | ');
    return { path, rankCats, text: clip(text, 300) };
  }

  function extractAsin() {
    const m = location.href.match(DP_RE);
    if (m) return m[1];
    const el = document.querySelector('[data-asin]:not([data-asin=""])');
    if (el) return el.getAttribute('data-asin');
    // detail bullets sometimes carry ASIN
    const pairs = getDetailPairs();
    const a = pairs.find(p => /^asin$/i.test(p.label));
    return a ? (a.value.match(/[A-Z0-9]{10}/) || [''])[0] : '';
  }

  // Collect label -> value pairs from every product-detail layout Amazon uses:
  //   - techSpec / additional-information TABLES (th + td)
  //   - detail-bullets LISTS ("Item Weight : 200 g")
  function getDetailPairs() {
    const pairs = [];
    const pushPair = (label, value) => {
      label = clip(label, 80).replace(/[:‎‏]+$/, '').trim();
      value = clip(value, 300).replace(/^[:‎‏\s]+/, '').trim();
      if (label && value) pairs.push({ label, value });
    };

    // Tables.
    document.querySelectorAll(
      '#productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr, ' +
      '#productDetails_detailBullets_sections1 tr, #productDetails_db_sections tr, ' +
      '#prodDetails table tr, .prodDetTable tr, table.a-keyvalue tr'
    ).forEach(tr => {
      const th = tr.querySelector('th');
      const td = tr.querySelector('td');
      if (th && td) pushPair(th.textContent, td.textContent);
    });

    // Detail bullets (UL with "label: value" spans).
    document.querySelectorAll(
      '#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li, #detail-bullets li'
    ).forEach(li => {
      const spans = li.querySelectorAll('span.a-text-bold, span');
      if (spans.length >= 2) {
        // First bold span is the label, the following text is the value.
        const labelEl = li.querySelector('span.a-text-bold') || spans[0];
        const label = labelEl.textContent || '';
        // value = li text minus label text
        const full = li.textContent || '';
        const value = full.replace(label, '');
        pushPair(label, value);
      } else {
        const t = (li.textContent || '');
        const idx = t.indexOf(':');
        if (idx > 0) pushPair(t.slice(0, idx), t.slice(idx + 1));
      }
    });

    return pairs;
  }

  // ----- BSR (spec §4): primary category rank, first "#N in Category". -------
  function parseBsr(pairs) {
    // Find the Best Sellers Rank pair; the value holds one or more "#N in Cat".
    let text = '';
    const p = pairs.find(x => /best\s*sellers?\s*rank/i.test(x.label));
    if (p) text = p.value;
    if (!text) {
      // Sometimes rank lives loose in a detail bullet/cell without a clean th/td split.
      const el = Array.from(document.querySelectorAll('li, tr, td, span, div')).find(e => /best\s*sellers?\s*rank/i.test(e.textContent || '') && /#\s*[\d,]+/.test(e.textContent || ''));
      if (el) text = el.textContent || '';
    }
    if (!text) {
      // Last resort: scan the whole page text (amazon.in sometimes renders BSR
      // in a section our selectors miss).
      const bt = document.body?.innerText || '';
      const idx = bt.search(/best\s*sellers?\s*rank/i);
      if (idx >= 0) text = bt.slice(idx, idx + 200);
    }
    if (!text) return null;
    // Primary = the FIRST "#1,234 in <Category>".
    const m = text.match(/#\s*([\d,]+)\s+in\s+/i) || text.match(/#\s*([\d,]+)/);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  // ----- Weight -> grams (spec §4): handle g/kg/oz/ounce(s)/lb/lbs/pound. ----
  const WEIGHT_LABELS = /item weight|package weight|net quantity|product weight|shipping weight|^weight$|product dimensions|package dimensions/i;
  function parseWeight(pairs) {
    let raw = '';
    // Prefer the most specific labels first.
    const order = [/item weight/i, /package weight/i, /shipping weight/i, /net quantity/i, /^weight$/i, /weight/i, /product dimensions/i, /package dimensions/i];
    for (const re of order) {
      const p = pairs.find(x => re.test(x.label));
      if (p && /\d/.test(p.value)) { raw = p.value; break; }
    }
    if (!raw) return { weightGrams: null, weightRaw: '', weightSource: null };
    const grams = weightToGrams(raw);
    return { weightGrams: grams, weightRaw: clip(raw, 80), weightSource: grams != null ? 'amazon' : null };
  }

  function weightToGrams(raw) {
    // Find "<number> <unit>" — pick the first weight-unit occurrence. Dimensions
    // strings like "10 x 5 x 3 cm; 200 grams" yield 200 g (cm is not a weight unit).
    const m = String(raw).match(/(\d+(?:[.,]\d{3})*(?:\.\d+)?)\s*(kilograms?|kgs?|grams?|gms?|g\b|ounces?|oz\b|pounds?|lbs?|lb\b)/i);
    if (!m) return null;
    // amazon.in/.com use a DOT decimal; commas are THOUSANDS separators
    // ("1,200 g" = 1200 g, NOT 1.2 g). Strip commas before parsing.
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    const unit = m[2].toLowerCase();
    let grams;
    if (/^(kilograms?|kgs?)$/.test(unit) || unit === 'kg') grams = value * 1000;
    else if (/^(grams?|gms?)$/.test(unit) || unit === 'g') grams = value * 1;
    else if (/^(ounces?)$/.test(unit) || unit === 'oz') grams = value * 28.3495;
    else if (/^(pounds?|lbs?)$/.test(unit) || unit === 'lb') grams = value * 453.592;
    else return null;
    return Math.round(grams);
  }

  // ----- Price (spec §4): .a-offscreen first, else whole+fraction. ----------
  function parsePrice() {
    const bodyText = document.body?.innerText || '';
    const unavailable = /cannot be shipped to your selected delivery location|currently unavailable|see all buying options|no featured offers available/i.test(bodyText);

    // BUYBOX / price blocks (center AND right column, plus Subscribe&Save and the
    // modern grocery layouts). NOT bare #centerCol (its first .a-offscreen is often
    // a SPONSORED price). Order = most-specific "price you pay" first.
    // ONE-TIME / main price blocks only — NOT #sns-base-price/#subscriptionPrice
    // (those are the discounted SUBSCRIBE price, which would be a wrong low price).
    const containers = [
      '#corePriceDisplay_desktop_feature_div', '#corePriceDisplay_feature_div', '#corePrice_feature_div',
      '#apex_desktop', '#apex_offerDisplay_desktop', '#price_inside_buybox',
      '#newAccordionRow', '#buyNew_noncbb',
      '#priceblock_ourprice', '#priceblock_dealprice', '#priceblock_saleprice',
      '#buybox', '#desktop_buybox', '#qualifiedBuybox', '#rightCol', '#tp_price_block_total_price_ww',
    ];
    // Read the "price you pay" from a block: prefer the modern priceToPay/
    // apexPriceToPay element, else any non-struck .a-price (.a-offscreen, else
    // whole+fraction). Skip struck-out MRP/"per unit" and $0.xx-per-ounce noise.
    const priceIn = (root) => {
      if (!root) return '';
      const off = root.querySelector(
        '.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .reinventPricePriceToPayMargin .a-offscreen,' +
        ' .a-price[data-a-color="base"] .a-offscreen, .a-price:not([data-a-strike]):not(.a-text-price) .a-offscreen');
      if (off && /[₹$]\s?\d/.test(off.textContent)) return off.textContent.trim();
      const whole = root.querySelector('.priceToPay .a-price-whole, .apexPriceToPay .a-price-whole, .a-price:not([data-a-strike]) .a-price-whole');
      if (whole) {
        const box = whole.closest('.a-price') || root;
        const w = (whole.textContent || '').replace(/[^\d]/g, '');
        const frac = (box.querySelector('.a-price-fraction')?.textContent || '').replace(/[^\d]/g, '');
        const sym = (box.querySelector('.a-price-symbol')?.textContent || '').trim();
        if (w) return `${sym}${w}${frac ? '.' + frac : ''}`;
      }
      return '';
    };
    let priceText = '';
    // Unavailable page → the headline price is the SELECTED variant swatch.
    if (unavailable) priceText = selectedVariantPrice();
    if (!priceText) { for (const sel of containers) { const p = priceIn(document.querySelector(sel)); if (p) { priceText = p; break; } } }
    if (!priceText) priceText = selectedVariantPrice();           // variant-grid (e.g. selected size tile)
    // Last resort: scan the buybox/center/RIGHT columns. Prefer the definitive
    // "price you pay" element; skip sponsored/related, "frequently bought", struck
    // MRP, and per-unit ("/ ounce", "/ count") secondary prices.
    if (!priceText && !unavailable) {
      const root = document.querySelector('#ppd, #centerCol, #rightCol, #desktop_buybox, #dp-container, #dp');
      if (root) {
        const SKIP = '[data-component-type="sp-sponsored-result"], [data-component-type="s-search-result"], .a-carousel, [cel_widget_id*="sponsored" i], [cel_widget_id*="similarities" i], #similarities_feature_div, #sims-consolidated-2_feature_div, #sp_detail, #sponsoredProducts, .s-result-item, #sns-tiered-price, [id*="freshBundle" i], .a-text-price';
        const grab = (nodes) => { for (const o of nodes) {
          if (o.closest(SKIP)) continue;
          const par = o.closest('.a-price'); if (par && /per\s*(unit|ounce|count|100|kg|g|ml|l)\b|\/\s*(ounce|count|oz|kg|g|ml|l)\b/i.test(par.parentElement?.textContent || '')) continue;
          const t = (o.textContent || '').trim(); if (/[₹$]\s?\d/.test(t)) return t;
        } return ''; };
        priceText = grab(root.querySelectorAll('.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen'))
                 || grab(root.querySelectorAll('.a-price:not([data-a-strike]) .a-offscreen'));
      }
    }
    // No real product price (e.g. unavailable / not sold here) → leave it blank.
    // Diagnostic: if the buybox VISIBLY shows a ₹/$ price we still failed to parse
    // (variant grid / Subscribe&Save layout), capture its HTML so the selector can
    // be locked. Only when a price is actually present — not for no-price products.
    if (!priceText) {
      let priceDebugHtml = '';
      if (!unavailable) {
        const dbg = document.querySelector('#corePriceDisplay_desktop_feature_div, #apex_desktop, #newAccordionRow, #buybox, #desktop_buybox, #rightCol, #ppd');
        if (dbg && /[₹$]\s?\d/.test(dbg.textContent || '')) priceDebugHtml = clip(dbg.outerHTML, 1600);
      }
      return { priceValue: null, currency: '', priceRaw: '', priceDebugHtml };
    }

    let currency = /₹|inr/i.test(priceText) ? 'INR' : /\$|usd/i.test(priceText) ? 'USD' : '';
    // Recover a missing symbol from the host: amazon.in is always INR. (Do NOT
    // assume USD on .com — it can render ₹ via Deliver-to-India; that's caught by
    // the ₹ test above, and a symbol-less .com price stays '' = flagged, never
    // written as USD.)
    if (!currency && /(^|\.)amazon\.in$/i.test(location.hostname)) currency = 'INR';
    // Take the FIRST number token (a "$34.89 - $40.00" range must not become
    // 34.8940.00) and strip thousands commas, keeping the decimal point.
    const num = ((priceText.match(/\d[\d,]*(?:\.\d+)?/) || [''])[0]).replace(/,/g, '');
    const value = parseFloat(num);
    return {
      priceValue: Number.isFinite(value) ? Math.round(value * 100) / 100 : null,
      currency,
      priceRaw: clip(priceText, 40),
    };
  }

  // Price of the SELECTED size/variant swatch (used when the buybox is
  // unavailable, e.g. "1 option from $34.89" on the chosen size). The page can
  // list MANY variants each with their own "option from $X" (e.g. a 10-count at
  // $15.99 AND the selected 30-count at $35.99). We must read the SELECTED
  // variant's price — never just the first one — and if we can't tell which is
  // selected, return blank (price left empty + flagged) rather than a wrong one.
  function selectedVariantPrice() {
    // Any inline-twister dimension row (size_name, style_name, color_name, …), not
    // just size — Dr Brown's etc. put the price under a Style/Color twister.
    const vscope = document.querySelector(
      '[id^="inline-twister-row-"], #tp-inline-twister-dim-values-container, #twisterContainer,' +
      ' #twister, #twister_feature_div, #variation_size_name, #variation_style_name, #variation_color_name,' +
      ' #centerCol, #ppd') || document;

    // Read a single unambiguous price out of an element: only accept it when the
    // element's subtree contains EXACTLY ONE distinct amount (so we never return
    // the first of several variants by accident).
    const onePrice = (el) => {
      if (!el) return '';
      const offs = [...(el.querySelectorAll ? el.querySelectorAll('.a-offscreen') : [])]
        .filter(o => !o.closest('[data-a-strike], .a-text-strike, del'))   // ignore struck-out MRP/list prices
        .map(o => (o.textContent || '').trim()).filter(t => /[₹$]/.test(t));
      const offUniq = [...new Set(offs.map(s => s.replace(/\s/g, '')))];
      if (offUniq.length === 1) return offs[0];
      const all = (el.textContent || '').match(/[₹$]\s?[\d.,]+/g) || [];
      const uniq = [...new Set(all.map(s => s.replace(/\s/g, '')))];
      return uniq.length === 1 ? all[0] : '';   // ambiguous → caller climbs/aborts
    };

    // 1) The SELECTED variant tile. Climb from the marker outward, stopping at the
    //    tightest ancestor that contains exactly one price (= this variant's tile,
    //    not the whole list which would hold every variant's price).
    const SEL = '.a-button-selected, [aria-checked="true"], [role="radio"][aria-checked="true"], li.selected, .swatch-list-item-text-container.selected, .a-button-toggle.a-button-selected, [data-a-selected="true"], [aria-current="true"], .swatchSelect, .dimension-value-list-item-square.selected';
    const sel = vscope.querySelector(SEL);
    if (sel) {
      for (let node = sel, i = 0; node && i < 4; node = node.parentElement, i++) {
        const p = onePrice(node);
        if (p) return p;
      }
    }
    // 2) Single-variant fallback: if the whole variant area has exactly ONE
    //    distinct price, it's unambiguous — use it. Multiple prices with no
    //    identifiable selection → blank (don't guess the wrong variant).
    return onePrice(vscope);
  }

  function getCanonicalUrl(asin) {
    // Prefer a clean, canonical /dp/ASIN URL (no tracking params) for Source Link.
    if (asin) return `${location.origin}/dp/${asin}`;
    const canon = document.querySelector('link[rel="canonical"]')?.href;
    if (canon && DP_RE.test(canon)) return canon.split('?')[0];
    return (canon || location.href).split('?')[0];
  }

  // ====================== Search-results scraping ===========================
  function scrapeSearchResults() {
    const cards = document.querySelectorAll('[data-component-type="s-search-result"], [data-asin][data-component-type], div.s-result-item[data-asin]');
    const out = [];
    cards.forEach((card, idx) => {
      const asin = card.getAttribute('data-asin') || '';
      if (!asin) return;
      let title = '';
      const h2 = card.querySelector('h2');
      if (h2) {
        let longest = '';
        h2.querySelectorAll('span').forEach(s => { const t = (s.textContent || '').trim(); if (t.length > longest.length) longest = t; });
        title = longest || (h2.textContent || '').trim();
      }
      if (!title || title.length < 10) {
        for (const sel of ['.a-size-medium.a-color-base.a-text-normal', '.a-size-base-plus.a-color-base.a-text-normal', 'h2 a']) {
          const t = (card.querySelector(sel)?.textContent || '').trim();
          if (t.length > title.length) title = t;
        }
      }
      const off = (card.querySelector('.a-price:not([data-a-strike]) .a-offscreen')?.textContent || '').trim();
      let priceValue = null, currency = '';
      if (off) { currency = /₹|inr/i.test(off) ? 'INR' : /\$|usd/i.test(off) ? 'USD' : ''; const v = parseFloat(off.replace(/[^\d.]/g, '')); priceValue = Number.isFinite(v) ? Math.round(v * 100) / 100 : null; }
      let brand = '';
      for (const sel of ['.a-row .a-size-base.a-link-normal', '.puis-bold-weight-text', '.s-label-popover-default span']) {
        const t = (card.querySelector(sel)?.textContent || '').trim();
        if (t.length > 2 && t.length < 50) { brand = t; break; }
      }
      const link = card.querySelector('h2 a')?.href || card.querySelector('a.a-link-normal[href*="/dp/"]')?.href || '';
      const sponsored = !!card.querySelector('.puis-label-popover-default, [data-component-type="sp-sponsored-result"]');
      out.push({ position: idx + 1, asin, title, brand, priceValue, currency, link, sponsored });
    });
    return out;
  }

  // =========================== §6 three-check match =========================
  // Confirm an EXACT-same product, not just same brand/packaging. Reject on any
  // spec conflict (count/pack/dosage/volume/weight/percentage/wattage) or any
  // qualifier swap (variant slot day/night, color/shade, line modifier).
  const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'with', 'and', 'pack', 'count', 'ct', 'set', 'new', 'amazon', 'by', 'in', 'pcs', 'pieces', 'piece', 'value', 'size']);
  const COLORS = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange', 'brown', 'grey', 'gray', 'silver', 'gold', 'beige', 'ivory', 'navy', 'teal', 'maroon', 'violet', 'cyan', 'magenta', 'tan', 'cream', 'rose', 'coral', 'mint', 'lavender', 'turquoise', 'burgundy', 'charcoal', 'bronze', 'copper', 'nude', 'peach', 'lilac', 'khaki', 'olive', 'mustard', 'wine', 'champagne', 'rosegold', 'rose gold'];
  const SLOTS = [['day', 'night'], ['am', 'pm'], ['morning', 'evening'], ['indoor', 'outdoor'], ['hot', 'cold'], ['summer', 'winter'], ['men', 'women'], ['mens', 'womens'], ['kids', 'adult']];

  function normWords(s) { return clip(s, 400).toLowerCase().replace(/[^a-z0-9%.]+/g, ' ').split(' ').filter(w => w && !STOP.has(w)); }

  function extractSpecs(title) {
    const t = ' ' + clip(title, 400).toLowerCase() + ' ';
    const specs = {};
    const grab = (re, kind, mult = 1) => { const m = t.match(re); if (m) { const v = parseFloat(m[1].replace(',', '.')) * mult; if (Number.isFinite(v)) specs[kind] = v; } };
    grab(/(\d+(?:\.\d+)?)\s*(?:mg|milligram)/, 'mass_mg');
    grab(/(\d+(?:\.\d+)?)\s*(?:mcg|microgram)/, 'mass_mcg');
    grab(/(\d+(?:\.\d+)?)\s*(?:g|gram|gm)\b/, 'mass_g');
    grab(/(\d+(?:\.\d+)?)\s*(?:kg|kilogram)/, 'mass_kg');
    grab(/(\d+(?:\.\d+)?)\s*ml\b/, 'vol_ml');
    grab(/(\d+(?:\.\d+)?)\s*(?:l|litre|liter)\b/, 'vol_l');
    grab(/(\d+(?:\.\d+)?)\s*(?:oz|ounce)/, 'mass_oz');
    grab(/(\d+(?:\.\d+)?)\s*(?:w|watt)\b/, 'watt');
    grab(/(\d+(?:\.\d+)?)\s*%/, 'percent');
    grab(/(?:pack|set|count|ct)\s*of\s*(\d+)/, 'pack');
    grab(/(\d+)\s*[- ]?(?:pack|count|ct|pcs|pieces)\b/, 'pack');
    return specs;
  }

  function specsConflict(a, b) {
    const tol = 0.001;
    for (const k of Object.keys(a)) {
      if (b[k] === undefined) continue;
      const x = a[k], y = b[k];
      if (Math.abs(x - y) > tol && Math.abs(x - y) / Math.max(x, y) > 0.02) return `${k} ${x}≠${y}`;
    }
    return null;
  }

  function qualifierConflict(qa, ta) {
    const A = new Set(normWords(qa)), B = new Set(normWords(ta));
    // variant slots: if both name a slot value but different ones -> conflict
    for (const slot of SLOTS) {
      const aHas = slot.filter(s => A.has(s)), bHas = slot.filter(s => B.has(s));
      if (aHas.length && bHas.length && aHas[0] !== bHas[0]) return `variant ${aHas[0]}≠${bHas[0]}`;
    }
    // color/shade: if both mention a color but different -> conflict
    const aColors = COLORS.filter(c => qa.toLowerCase().includes(c));
    const bColors = COLORS.filter(c => ta.toLowerCase().includes(c));
    if (aColors.length && bColors.length && !aColors.some(c => bColors.includes(c))) return `color ${aColors[0]}≠${bColors[0]}`;
    return null;
  }

  function titleSimilarity(a, b) {
    const A = new Set(normWords(a)), B = new Set(normWords(b));
    if (!A.size || !B.size) return 0;
    let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
    return inter / Math.sqrt(A.size * B.size); // cosine-ish on sets
  }

  function brandMatch(queryBrand, query, candBrand, candTitle) {
    const qb = normWords(queryBrand || query)[0] || '';
    const cb = (normWords(candBrand)[0] || '') || (normWords(candTitle)[0] || '');
    if (!qb) return true; // can't gate without a brand
    return qb === cb || candTitle.toLowerCase().includes(qb) || (candBrand || '').toLowerCase().includes(qb);
  }

  function matchResults({ query, brand, threshold = 0.45 }) {
    const results = scrapeSearchResults().filter(r => !r.sponsored && r.title);
    const qSpecs = extractSpecs(query);
    const scored = [];
    for (const r of results.slice(0, 12)) {
      const reasons = [];
      // 1) brand + title gate
      const sim = titleSimilarity(query, r.title);
      if (!brandMatch(brand, query, r.brand, r.title)) { reasons.push('brand mismatch'); }
      if (sim < threshold) reasons.push(`title sim ${sim.toFixed(2)}<${threshold}`);
      // 2) spec conflict
      const sc = specsConflict(qSpecs, extractSpecs(r.title));
      if (sc) reasons.push('spec: ' + sc);
      // 3) qualifier conflict
      const qc = qualifierConflict(query, r.title);
      if (qc) reasons.push('qual: ' + qc);
      scored.push({ ...r, sim, confident: reasons.length === 0, reasons });
    }
    scored.sort((a, b) => (b.confident - a.confident) || (b.sim - a.sim));
    const best = scored.find(s => s.confident) || null;
    return { match: best, candidates: scored.slice(0, 6) };
  }

  // ===================== Set US delivery location ===========================
  // Drives amazon.com's "Deliver to" location modal to a US ZIP so the page
  // renders USD (the India IP otherwise defaults .com to ₹). Best-effort; Amazon
  // rotates these selectors, so it's defensive.
  function _setVal(el, v) {
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function _waitSel(sel, ms) {
    const t = Date.now();
    while (Date.now() - t < ms) { const e = document.querySelector(sel); if (e) return e; await sleep(200); }
    return null;
  }
  async function setUsLocation(zip) {
    zip = String(zip || '10001').trim();
    const trigger = document.querySelector('#nav-global-location-popover-link, #glow-ingress-block, a#nav-global-location-popover-link, [data-action="a-popover"] #glow-ingress-block');
    if (!trigger) return { ok: false, error: 'location link not found' };
    trigger.click();
    const input = await _waitSel('#GLUXZipUpdateInput, input[autocomplete="postal-code"], #GLUXZipUpdateInput_0', 6000);
    if (!input) return { ok: false, error: 'ZIP input not found (modal layout changed)' };
    input.focus(); _setVal(input, zip);
    await sleep(300);
    const apply = document.querySelector('#GLUXZipUpdate input[type="submit"], #GLUXZipUpdate-announce, span#GLUXZipUpdate input[type="submit"], #GLUXZipUpdate input');
    if (apply) apply.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await sleep(1600);
    const done = document.querySelector('button[name="glowDoneButton"], .a-popover-footer .a-button-input, #GLUXConfirmClose, [data-action="GLUXConfirmAction"] input');
    if (done) done.click();
    await sleep(900);
    return { ok: true, zip };
  }

  // ============================== RPC =======================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = msg?.type;

    if (type === 'AMAZON_PING') { sendResponse({ ok: true, ready: true }); return false; }

    if (type === 'SET_US_LOCATION') {
      setUsLocation(msg.zip).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }

    if (type === 'DETECT_PAGE_TYPE') {
      try { sendResponse({ ok: true, pageType: detectPageType(), url: location.href }); }
      catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
      return false;
    }

    if (type === 'SCRAPE_PRODUCT') {
      try {
        const data = scrapeProduct();
        log(`scrape ${data.asin || '?'}: bsr=${data.bsrPrimary} weight=${data.weightGrams}g ` +
            `price=${data.currency}${data.priceValue}`, 'ok');
        if (data.priceValue == null && data.priceDebugHtml) {
          log(`${data.asin || '?'}: PRICE PARSE FAILED — the buybox shows a price we missed. Copy & send this so I can lock it: ${String(data.priceDebugHtml).slice(0, 800)}`, 'warn');
        }
        sendResponse({ ok: true, data });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
      return false;
    }

    if (type === 'SEARCH_AND_MATCH') {
      // Runs on an Amazon search-results page (the worker navigates there first).
      // Scrapes results and runs the §6 three-check; returns the confident match
      // (or null) plus the top candidates with reject reasons for the audit log.
      try {
        const { match, candidates } = matchResults({ query: msg.query, brand: msg.brand, threshold: msg.threshold });
        log(`search "${clip(msg.query, 50)}": ${candidates.length} candidates, match=${match ? match.asin : 'none'}`, match ? 'ok' : 'warn');
        sendResponse({ ok: true, match, candidates });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
      return false;
    }
  });

  log(`Dropy amazon content script ready on ${location.host}`, 'info');
})();
