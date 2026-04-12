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
        highlightSelection();
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

  // ── Floating toolbar on text selection ─────────────────────────────────────

  let toolbar = null;
  let selectionTimeout = null;

  function onSelectionEnd() {
    clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (text && text.length > 0 && text.length < 500 && sel.rangeCount > 0) {
        showToolbar(sel, text);
      } else {
        hideToolbar();
      }
    }, 220);
  }

  // Listen on both mouseup and pointerup — PDF viewers sometimes only fire one
  document.addEventListener("mouseup",   onSelectionEnd, true);
  document.addEventListener("pointerup", onSelectionEnd, true);

  // selectionchange fires reliably even when mouseup is swallowed
  let scTimeout = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(scTimeout);
    scTimeout = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text) hideToolbar();
    }, 400);
  });

  document.addEventListener("mousedown", (e) => {
    if (toolbar && !toolbar.contains(e.target)) {
      hideToolbar();
    }
  }, true);

  function showToolbar(sel, text) {
    hideToolbar();

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // Skip if rect is degenerate (invisible/collapsed)
    if (!rect || rect.width === 0 && rect.height === 0) return;

    toolbar = createElement("div", "sr-toolbar", `
      <button class="sr-tool-btn" data-action="highlight" title="Highlight">✏️ Highlight</button>
      <button class="sr-tool-btn" data-action="define"    title="Define">📖 Define</button>
      <button class="sr-tool-btn" data-action="translate" title="Translate">🌐 Translate</button>
      <button class="sr-tool-btn" data-action="dict"      title="Add to Dictionary">📝 Dictionary</button>
    `);

    // Use fixed positioning — works correctly inside iframes and PDF viewers
    const x = Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80);
    // If selection is near top, show toolbar below instead of above
    const y = rect.top > 60 ? rect.top - 8 : rect.bottom + 8;

    toolbar.style.left = `${x}px`;
    toolbar.style.top  = `${y}px`;
    // If near bottom, flip above
    if (y > window.innerHeight - 80) {
      toolbar.style.top = `${rect.top - 8}px`;
    }

    // Append to <html> not <body> to avoid overflow:hidden clipping
    document.documentElement.appendChild(toolbar);
    requestAnimationFrame(() => toolbar.classList.add("sr-visible"));

    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      hideToolbar();
      if (action === "define") handleDefine(text);
      else if (action === "translate") handleTranslate(text);
      else if (action === "highlight") highlightSelection();
      else if (action === "dict") handleAddToDictionary(text);
    });
  }

  function hideToolbar() {
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
  }

  // ── Highlight ───────────────────────────────────────────────────────────────

  function highlightSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return;

    const range = sel.getRangeAt(0);
    try {
      const mark = document.createElement("mark");
      mark.className = "sr-highlight";
      mark.style.backgroundColor = settings.highlightColor;
      range.surroundContents(mark);
      sel.removeAllRanges();
      showToast("Text highlighted.", "success");
    } catch {
      // Range spans multiple elements – wrap each text node individually
      wrapRangeInMark(range);
      sel.removeAllRanges();
      showToast("Text highlighted.", "success");
    }
  }

  function wrapRangeInMark(range) {
    const fragment = range.extractContents();
    const mark = document.createElement("mark");
    mark.className = "sr-highlight";
    mark.style.backgroundColor = settings.highlightColor;
    mark.appendChild(fragment);
    range.insertNode(mark);
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
