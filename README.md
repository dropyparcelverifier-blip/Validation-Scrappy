# Dropy Auto-Validator (MV3)

Automates the **Scrappy v2 → Dropy → Validation** manual product-validation loop by
driving your real, logged-in browser (Edge/Chrome) so Amazon's bot-walls treat it
as a normal human. No headless/server-side scraping.

See the build spec for the full algorithm (§1) and verification checklist (§9).

## Status: full build (Phases 0–5)

- MV3 manifest, side panel, service worker, dashboard + Amazon content scripts.
- **Scan mode**: dumps the grid structure (headers, column guesses, sample rows,
  inputs, buttons, dropdowns, status tabs, ALL/RS/DP toggle, pagination, raw HTML)
  to confirm/tune selectors.
- **Run engine** (`modules/engine.js`): the §1 state machine — per-row India leg
  (open .in → detect → scrape BSR/weight/INR → funnel RS/DP → write), USA leg
  (open .com → scrape USD + canonical → write, or the USA-NF search + §6
  three-check match), India-Link-NF branch, category select, Pass.
- One managed Amazon tab, randomised 4–9 s throttle, 30 s timeout + 1 retry.
- **Dedupe + resume**: processed ASINs persist to `chrome.storage`; clicking Start
  after a restart skips finished rows (no re-scraping).
- **Dry-run** (default ON): fills every field but withholds Pass / Link NF /
  USA Link NF clicks.
- **LLM weight fallback** (Gemini): used only when Amazon has no weight; results
  flagged `weight_source=llm` and medium/low confidence flagged for review.
- CAPTCHA → pause-for-human (Amazon tab brought to front) → Resume re-runs the row.
- Per-row audit records + CSV/JSON export.

### Decisions baked in
DOM-only writes · Gemini weight fallback · leave-blank + flag on no category match.

### Still needs your confirmation (spec §9)
Selectors are chosen by header text / button label / position, so they should work
without the dashboard source — but **run a Scan and a dry-run first** and check the
log: if a `write X failed` or `Pass button not found` appears, paste the Scan JSON
back so the anchors can be locked. Specifically confirm: inline-editable
Weight/INR/USD inputs, native vs custom Category dropdown, checkbox→enables
Link NF/USA Link NF, Next pagination re-render, and whether Funnel is writable.

## Load it (unpacked)

1. Edge: `edge://extensions` (or Chrome: `chrome://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this folder (`ValidationScrappy`).
4. Click the extension icon to open the **side panel**.

The dashboard content script is **not** in the manifest — it's registered at
runtime for the configured origin (Settings → Dashboard origin). Default is the
Tailscale test IP from the spec. Change it and Save; it re-registers and injects
into any open dashboard tab.

## Run the Scan (do this first)

1. Open the Validation dashboard in a tab (must match the configured origin).
2. Side panel → **Scan** tab → **Scan dashboard**.
3. Review the dump. Use **Copy JSON** and paste it back so the exact selectors
   can be locked, and the §9 VERIFY questions answered, before Phase 1.

Open a real Amazon product page and a 404/"dog" page, then **Probe Amazon tab**
to confirm page-type detection.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (Amazon CS static; dashboard CS dynamic). |
| `config.js` | Defaults + storage keys (SW module). |
| `background.js` | Orchestrator: registration, Scan routing, settings, log, state. |
| `sidepanel.html` / `sidepanel.js` | Control + observability UI. |
| `content/dashboard.js` | `SCAN`, `READ_PAGE_ROWS`, `WRITE_FIELD`, category/funnel, Pass, checkbox, NF buttons, Next. |
| `content/amazon.js` | Page detection, `SCRAPE_PRODUCT` (BSR/weight/price), `SEARCH_AND_MATCH` (§6). |
| `modules/engine.js` | The §1 state machine + category mapping. |
| `modules/amazon-tab.js` | One managed Amazon tab (navigate/ping/throttle/foreground). |
| `modules/llm.js` | LLM weight fallback (Gemini / Anthropic / OpenAI). |
