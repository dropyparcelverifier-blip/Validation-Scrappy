// content/llm-web.js — drives the Gemini / ChatGPT web UI in the user's
// logged-in session (weight fallback, no API key).
//   LLM_PING -> { ok, site, ready }   ready=false usually means a login wall
//   LLM_ASK {prompt} -> { ok, text }  types the prompt, waits for the answer
//
// Brittle by nature (these UIs change). Selectors are kept broad and there's a
// "wait until the answer text stops growing" settle heuristic.

(function () {
  if (window.__davLlmReady) return;
  window.__davLlmReady = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const host = location.host;
  const SITE = /gemini\.google/.test(host) ? 'gemini' : (/chatgpt\.com|chat\.openai/.test(host) ? 'chatgpt' : 'other');

  function log(text, kind) { try { chrome.runtime.sendMessage({ action: 'logFromContent', source: 'llm-web', text, kind }).catch(() => {}); } catch {} }

  function getInput() {
    if (SITE === 'gemini') return document.querySelector('rich-textarea .ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]');
    if (SITE === 'chatgpt') return document.querySelector('#prompt-textarea, div[contenteditable="true"]#prompt-textarea, textarea#prompt-textarea, [contenteditable="true"][data-virtualkeyboard="true"]') || document.querySelector('textarea[data-id], div.ProseMirror[contenteditable="true"]');
    return document.querySelector('[contenteditable="true"], textarea');
  }
  const _vis = el => !!(el && el.offsetParent !== null);
  // The chat input exists even when logged out, so we must also check sign-in:
  // a visible "Sign in"/"Log in" control means NOT ready.
  function isSignedIn() {
    const re = SITE === 'chatgpt' ? /^\s*(log\s*in|login|sign\s*up)\s*$/i : /^\s*sign\s*in\s*$/i;
    const out = Array.from(document.querySelectorAll('a, button')).some(el => re.test((el.textContent || '').trim()) && _vis(el));
    return !out;
  }

  // One element PER assistant turn (stable count), so "a new answer arrived"
  // means responseEls().length increased.
  function responseEls() {
    if (SITE === 'gemini') return document.querySelectorAll('model-response, .model-response-text');
    if (SITE === 'chatgpt') return document.querySelectorAll('[data-message-author-role="assistant"]');
    return document.querySelectorAll('[data-message-author-role="assistant"], .model-response-text');
  }

  // Start a brand-new conversation so each request is isolated (prevents the
  // previous row's answer bleeding into this one). Best-effort: click the
  // site's "New chat" control; falls back to clearing the input.
  async function startFreshChat() {
    let btn = null;
    if (SITE === 'gemini') {
      btn = document.querySelector('[data-test-id="new-chat-button"] button, [data-test-id="new-chat-button"], button[aria-label*="New chat" i], button[aria-label*="New conversation" i]');
    } else if (SITE === 'chatgpt') {
      btn = document.querySelector('a[data-testid="create-new-chat-button"], button[data-testid="create-new-chat-button"], a[aria-label*="New chat" i], button[aria-label*="New chat" i], nav a[href="/"]');
    }
    if (btn) { btn.click(); await sleep(900); }
    // Make sure the input is empty after switching.
    const inp = getInput();
    if (inp) { if (inp.tagName === 'TEXTAREA') { inp.value = ''; } else { inp.textContent = ''; } }
    return !!btn;
  }

  function isStreaming() {
    if (SITE === 'chatgpt') return !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]');
    if (SITE === 'gemini') return !!document.querySelector('button[aria-label*="Stop"], .stop-icon, [data-test-id="stop-button"]');
    return false;
  }

  function setInputText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      desc?.set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contenteditable — select-all then insertText so the framework's model updates.
    try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, text); } catch {}
    if (!(el.textContent || '').trim()) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  function clickSend() {
    let btn = null;
    if (SITE === 'gemini') btn = document.querySelector('button.send-button, button[aria-label*="Send"], button[mattooltip*="Send"]');
    if (SITE === 'chatgpt') btn = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function ask(prompt, timeoutMs) {
    // Fresh conversation per request so the previous row's answer can't leak in.
    await startFreshChat();

    const input = getInput();
    if (!input) throw new Error(`no chat input found on ${host} (logged in?)`);
    const prevCount = responseEls().length;   // 0 after a fresh chat

    setInputText(input, prompt);
    await sleep(300);
    if (!clickSend()) { input.focus(); pressEnter(input); }

    const deadline = Date.now() + (timeoutMs || 120000);

    // Wait for a genuinely NEW response element (count must INCREASE). Never
    // grab a stale prior message — that was the answer-bleed bug.
    let el = null;
    while (Date.now() < deadline) {
      const els = responseEls();
      if (els.length > prevCount) { el = els[els.length - 1]; break; }
      await sleep(400);
    }
    if (!el) throw new Error('no new response appeared (UI changed or not logged in)');

    // Wait for streaming to finish: text must be non-empty, unchanged for ~1.8s,
    // and the stop/streaming indicator gone.
    let last = '', stableSince = Date.now();
    while (Date.now() < deadline) {
      const t = el.textContent || '';
      if (t !== last) { last = t; stableSince = Date.now(); }
      else if (!isStreaming() && last.trim() && Date.now() - stableSince > 1800) break;
      else if (last.trim() && Date.now() - stableSince > 6000) break; // hard settle
      await sleep(400);
    }
    if (!last.trim()) throw new Error('empty response');
    log(`answered (${last.length} chars)`, 'ok');
    return last;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'LLM_PING') { const si = isSignedIn(); sendResponse({ ok: true, site: SITE, ready: !!getInput() && si, signedIn: si }); return false; }
    if (msg?.type === 'LLM_ASK') {
      ask(String(msg.prompt || ''), msg.timeoutMs)
        .then(text => sendResponse({ ok: true, text }))
        .catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
  });

  log(`Dropy LLM-web content script ready on ${host} (site=${SITE})`, 'info');
})();
