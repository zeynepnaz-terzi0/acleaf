// Acleaf - Content Script

(function () {
  if (window.__acleafLoaded) return;
  window.__acleafLoaded = true;

  // ── Skip truly empty/system frames (chrome-extension://, about:, etc.) ─────
  const loc = window.location.href;
  if (!loc || loc.startsWith("about:") || loc.startsWith("chrome:") || loc.startsWith("devtools:")) return;

  // ── Settings ───────────────────────────────────────────────────────────────

  let settings = { translateLang: "TR", highlightColor: "#FFD700" };

  chrome.storage.local.get("settings", ({ settings: s }) => {
    if (s) settings = { ...settings, ...s };
  });

  // ── DOM-based PDF detection (catches URLs background script misses) ─────────

  function looksLikePdfViewer() {
    // Embedded PDF object/embed tags
    const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
    if (embed) return true;
    // PDF.js canvas-based viewer
    if (document.querySelector('#viewer .page, .pdfViewer .page')) return true;
    // Common PDF viewer wrapper IDs/classes
    if (document.querySelector('#viewerContainer, #outerContainer, .pdf-viewer, #pdf-viewer')) return true;
    // Title contains common PDF book/doc signals when URL has fstream/stream
    const url = window.location.href.toLowerCase();
    if ((url.includes('fstream') || url.includes('stream') || url.includes('view')) &&
        document.title && document.title.length > 5) return true;
    return false;
  }

  // Only run DOM detection on the top frame to avoid duplicate prompts from iframes
  if (window === window.top) {
    window.addEventListener("load", () => {
      setTimeout(() => {
        if (looksLikePdfViewer()) {
          const url = window.location.href;
          const title = document.title || url;
          // Auto-save to Last Seen silently
          chrome.runtime.sendMessage({ type: "ADD_TO_LAST_SEEN", url, title }).catch(() => {});
          // Show save-to-library prompt
          if (!document.getElementById("sr-save-prompt")) {
            showSavePrompt(url, title);
          }
        }
      }, 1500);
    });
  }

  // ── Message listener ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "SHOW_SAVE_PROMPT":
        showSavePrompt(msg.url, msg.title);
        break;
      case "DEFINE_WORD":
        handleDefine(msg.word);
        break;
      case "TRANSLATE_WORD":
        handleTranslate(msg.word);
        break;
      case "ADD_TO_DICTIONARY":
        handleAddToDictionary(msg.word);
        break;
      case "HIGHLIGHT_SELECTION":
        highlightInFrame(savedRange, savedText, savedIframe);
        break;
    }
  });

  // ── Save prompt ─────────────────────────────────────────────────────────────

  function showSavePrompt(url, title) {
    if (document.getElementById("sr-save-prompt")) return;

    const prompt = createElement("div", "sr-save-prompt", `
      <div class="sr-prompt-icon">📄</div>
      <div class="sr-prompt-text">
        <strong>PDF Detected</strong>
        <span>${truncate(title, 60)}</span>
      </div>
      <div class="sr-prompt-actions">
        <button class="sr-btn sr-btn-primary" id="sr-save-yes">Save</button>
        <button class="sr-btn sr-btn-ghost" id="sr-save-no">Dismiss</button>
      </div>
      <button class="sr-close" id="sr-prompt-close">✕</button>
    `);

    document.body.appendChild(prompt);
    requestAnimationFrame(() => prompt.classList.add("sr-visible"));

    document.getElementById("sr-save-yes").onclick = async () => {
      const btn = document.getElementById("sr-save-yes");
      btn.textContent = "Saving…";
      btn.disabled = true;
      const result = await chrome.runtime.sendMessage({ type: "SAVE_PDF", url, title });
      if (result?.duplicate) {
        showToast("Already in your library.", "info");
      } else {
        showToast("PDF saved to your library!", "success");
      }
      dismissPrompt(prompt);
    };

    document.getElementById("sr-save-no").onclick = () => dismissPrompt(prompt);
    document.getElementById("sr-prompt-close").onclick = () => dismissPrompt(prompt);

    // Auto-dismiss after 12s
    setTimeout(() => dismissPrompt(prompt), 12000);
  }

  function dismissPrompt(el) {
    if (!el || !el.parentNode) return;
    el.classList.remove("sr-visible");
    setTimeout(() => el.remove(), 350);
  }

  // ── Only run the toolbar logic in the TOP frame ────────────────────────────
  // Instead of relying on events from child frames (unreliable), we directly
  // query every iframe's selection from the parent using contentWindow.getSelection()
  if (window !== window.top) return; // child frames: nothing needed here

  // ── Selection state ─────────────────────────────────────────────────────────
  let savedText      = "";
  let savedRange     = null;
  let savedIframe    = null;  // which iframe had the selection (null = top frame)
  let toolbar        = null;
  let toolbarTimer   = null;

  // ── Core: find selection in top frame OR any same-origin child iframe ───────
  function findSelection() {
    // 1. Check top frame
    const topSel = window.getSelection();
    const topText = topSel?.toString().trim();
    if (topText && topText.length > 0 && topSel.rangeCount > 0) {
      return { text: topText, sel: topSel, iframe: null };
    }

    // 2. Check every iframe — same-origin ones are accessible directly
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const frameSel  = iframe.contentWindow?.getSelection();
        const frameText = frameSel?.toString().trim();
        if (frameText && frameText.length > 0 && frameSel.rangeCount > 0) {
          return { text: frameText, sel: frameSel, iframe };
        }
      } catch { /* cross-origin — skip */ }
    }
    return null;
  }

  // Convert a rect from an iframe's coordinate space to top-frame viewport coords
  function toTopRect(rect, iframe) {
    if (!iframe) return rect;
    const iframeRect = iframe.getBoundingClientRect();
    return {
      top:    rect.top    + iframeRect.top,
      bottom: rect.bottom + iframeRect.top,
      left:   rect.left   + iframeRect.left,
      right:  rect.right  + iframeRect.left,
      width:  rect.width,
      height: rect.height
    };
  }

  // ── Trigger: check selection on every mouseup anywhere on the page ──────────
  function onPointerUp(e) {
    if (toolbar?.contains(e.target)) return;
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(() => {
      const found = findSelection();
      if (!found) return;

      savedText   = found.text;
      savedIframe = found.iframe;
      try { savedRange = found.sel.getRangeAt(0).cloneRange(); } catch {}

      updateFab(true);

      // Get rect in top-frame coords
      let rect;
      try { rect = toTopRect(found.sel.getRangeAt(0).getBoundingClientRect(), found.iframe); } catch { return; }

      // If rect is degenerate, fall back to mouse position
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        rect = { top: e.clientY - 2, bottom: e.clientY, left: e.clientX, right: e.clientX, width: 0, height: 0 };
      }
      showToolbar(rect, found.text);
    }, 120);
  }

  // Listen on the top frame document — catches clicks on the page wrapper
  document.addEventListener("mouseup",   onPointerUp, true);
  document.addEventListener("pointerup", onPointerUp, true);

  // Also attach listeners directly on each iframe element so we catch
  // mouse events that stay entirely within the iframe
  function attachIframeListeners() {
    document.querySelectorAll("iframe").forEach(iframe => {
      if (iframe.__acleafBound) return;
      iframe.__acleafBound = true;
      try {
        iframe.contentDocument?.addEventListener("mouseup",   onPointerUp, true);
        iframe.contentDocument?.addEventListener("pointerup", onPointerUp, true);
      } catch {}
    });
  }
  // Attach now and whenever new iframes are added
  attachIframeListeners();
  new MutationObserver(attachIframeListeners).observe(document.body || document.documentElement, { childList: true, subtree: true });

  document.addEventListener("mousedown", (e) => {
    if (toolbar && !toolbar.contains(e.target)) hideToolbar();
  }, true);

  // ── Floating toolbar ────────────────────────────────────────────────────────
  function showToolbar(rect, text) {
    hideToolbar();
    toolbar = createElement("div", "sr-toolbar", `
      <button class="sr-tool-btn" data-action="highlight">✏️ Highlight</button>
      <button class="sr-tool-btn" data-action="define">📖 Define</button>
      <button class="sr-tool-btn" data-action="translate">🌐 Translate</button>
      <button class="sr-tool-btn" data-action="dict">📝 Dictionary</button>
    `);

    const x = Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90);
    const above = rect.top > 52;
    const y = above ? rect.top - 10 : rect.bottom + 10;
    toolbar.style.cssText = `position:fixed!important;left:${x}px;top:${y}px;transform:translate(-50%,${above?"-100%":"0"})`;
    document.documentElement.appendChild(toolbar);
    requestAnimationFrame(() => toolbar.classList.add("sr-visible"));

    toolbar.addEventListener("mousedown", e => e.stopPropagation(), true);
    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const ct = savedText; const cr = savedRange; const ci = savedIframe;
      hideToolbar();
      if (action === "highlight") highlightInFrame(cr, ct, ci);
      else if (action === "define")    handleDefine(ct);
      else if (action === "translate") handleTranslate(ct);
      else if (action === "dict")      handleAddToDictionary(ct);
    });
  }

  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  // ── Corner FAB ──────────────────────────────────────────────────────────────
  const fab = createElement("div", "sr-fab", "✦");
  fab.title = "Acleaf — click after selecting text";
  document.documentElement.appendChild(fab);

  function updateFab(hasSelection) {
    fab.classList.toggle("sr-fab-active", hasSelection);
  }

  // Dim FAB when selection is cleared
  document.addEventListener("selectionchange", () => {
    const found = findSelection();
    if (!found) {
      setTimeout(() => { if (!findSelection()) updateFab(false); }, 300);
    }
  });

  fab.addEventListener("click", (e) => {
    e.stopPropagation();
    // Re-check selection at click time (user may have re-selected)
    const found = findSelection();
    if (found) {
      savedText   = found.text;
      savedIframe = found.iframe;
      try { savedRange = found.sel.getRangeAt(0).cloneRange(); } catch {}
    }
    if (!savedText) {
      showToast("Select text in the PDF first.", "info");
      return;
    }
    const r = fab.getBoundingClientRect();
    showToolbar({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }, savedText);
  });

  // ── Highlight ───────────────────────────────────────────────────────────────

  function highlightInFrame(range, text, iframe) {
    // If the selection was in an iframe, re-fetch its live selection for highlight
    // (cloned ranges can't surroundContents across documents)
    if (iframe) {
      try {
        const frameSel = iframe.contentWindow?.getSelection();
        if (frameSel && frameSel.rangeCount > 0 && frameSel.toString().trim()) {
          const liveRange = frameSel.getRangeAt(0);
          const doc = iframe.contentDocument;
          applyHighlight(liveRange, frameSel, doc);
          return;
        }
      } catch {}
    }
    // Top frame highlight
    const sel = window.getSelection();
    const liveRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : range;
    if (!liveRange) { showToast("Select text first.", "info"); return; }
    applyHighlight(liveRange, sel, document);
  }

  function applyHighlight(range, sel, doc) {
    try {
      const mark = (doc || document).createElement("mark");
      mark.className = "sr-highlight";
      mark.style.backgroundColor = settings.highlightColor;
      range.surroundContents(mark);
      sel?.removeAllRanges();
      savedRange = null; savedText = "";
      showToast("Highlighted!", "success");
    } catch {
      try {
        const fragment = range.extractContents();
        const mark = (doc || document).createElement("mark");
        mark.className = "sr-highlight";
        mark.style.backgroundColor = settings.highlightColor;
        mark.appendChild(fragment);
        range.insertNode(mark);
        sel?.removeAllRanges();
        savedRange = null; savedText = "";
        showToast("Highlighted!", "success");
      } catch {
        showToast("Cannot highlight this text.", "error");
      }
    }
  }

  // ── Define ──────────────────────────────────────────────────────────────────

  async function handleDefine(word) {
    const panel = showPanel("define", word, `<p class="sr-loading">Looking up <em>${escHtml(word)}</em>…</p>`);
    const result = await chrome.runtime.sendMessage({ type: "FETCH_DEFINITION", word });

    if (result.error) {
      updatePanel(panel, `<p class="sr-error">${escHtml(result.error)}</p>`);
      return;
    }

    const html = `
      <div class="sr-def-word">${escHtml(result.word)}</div>
      ${result.phonetic ? `<div class="sr-phonetic">${escHtml(result.phonetic)}</div>` : ""}
      ${(result.meanings || []).map(m => `
        <div class="sr-pos">${escHtml(m.partOfSpeech)}</div>
        <ol class="sr-defs">
          ${(m.definitions || []).map(d => `<li>${escHtml(d)}</li>`).join("")}
        </ol>
      `).join("")}
      <button class="sr-btn sr-btn-sm" id="sr-save-def">Add to Dictionary</button>
    `;
    updatePanel(panel, html);

    panel.querySelector("#sr-save-def")?.addEventListener("click", () => {
      const defText = (result.meanings?.[0]?.definitions?.[0]) || "";
      handleAddToDictionary(word, defText);
    });
  }

  // ── Translate ───────────────────────────────────────────────────────────────

  async function handleTranslate(word) {
    const panel = showPanel("translate", word, `<p class="sr-loading">Translating…</p>`);
    const result = await chrome.runtime.sendMessage({
      type: "FETCH_TRANSLATION",
      word,
      targetLang: settings.translateLang
    });

    if (result.error) {
      updatePanel(panel, `<p class="sr-error">${escHtml(result.error)}</p>`);
      return;
    }

    const html = `
      <div class="sr-original">${escHtml(word)}</div>
      <div class="sr-arrow">→</div>
      <div class="sr-translated">${escHtml(result.translation)}</div>
      <div class="sr-lang-badge">EN → ${escHtml(settings.translateLang)}</div>
      <button class="sr-btn sr-btn-sm" id="sr-save-trans">Add to Dictionary</button>
    `;
    updatePanel(panel, html);

    panel.querySelector("#sr-save-trans")?.addEventListener("click", () => {
      handleAddToDictionary(word, "", result.translation);
    });
  }

  // ── Add to dictionary ────────────────────────────────────────────────────────

  async function handleAddToDictionary(word, definition = "", translation = "") {
    const result = await chrome.runtime.sendMessage({
      type: "ADD_TO_DICTIONARY_BG",
      word,
      definition,
      translation
    });
    if (result?.success) {
      showToast(`"${truncate(word, 30)}" added to dictionary.`, "success");
    }
  }

  // ── Generic panel ─────────────────────────────────────────────────────────

  let activePanel = null;

  function showPanel(type, title, contentHtml) {
    closePanel();

    activePanel = createElement("div", `sr-panel sr-panel-${type}`, `
      <div class="sr-panel-header">
        <span class="sr-panel-title">${type === "define" ? "Definition" : "Translation"}: <em>${escHtml(truncate(title, 40))}</em></span>
        <button class="sr-close" id="sr-panel-close">✕</button>
      </div>
      <div class="sr-panel-body">${contentHtml}</div>
    `);

    document.body.appendChild(activePanel);
    requestAnimationFrame(() => activePanel.classList.add("sr-visible"));

    activePanel.querySelector("#sr-panel-close").onclick = closePanel;
    return activePanel;
  }

  function updatePanel(panel, html) {
    const body = panel?.querySelector(".sr-panel-body");
    if (body) body.innerHTML = html;
  }

  function closePanel() {
    if (activePanel) {
      activePanel.classList.remove("sr-visible");
      const p = activePanel;
      setTimeout(() => p.remove(), 300);
      activePanel = null;
    }
  }

  // ── Toast ───────────────────────────────────────────────────────────────────

  function showToast(message, type = "info") {
    const toast = createElement("div", `sr-toast sr-toast-${type}`, escHtml(message));
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("sr-visible"));
    setTimeout(() => {
      toast.classList.remove("sr-visible");
      setTimeout(() => toast.remove(), 350);
    }, 3000);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function createElement(tag, classes, innerHTML) {
    const el = document.createElement(tag);
    el.className = classes;
    el.innerHTML = innerHTML;
    return el;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + "…" : str;
  }
})();
