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

  // ── Frame identity ──────────────────────────────────────────────────────────
  const isTopFrame = (window === window.top);

  // Stub — replaced by real impl once setupFab() runs in top frame
  let updateFab = () => {};

  // ── Selection state — saved immediately on every selectionchange ────────────
  let savedText  = "";
  let savedRange = null;
  let toolbarTimer = null;

  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();

    if (text && text.length > 0 && text.length < 500 && sel.rangeCount > 0) {
      savedText = text;
      try { savedRange = sel.getRangeAt(0).cloneRange(); } catch {}

      // Tell the top frame so its FAB can light up
      if (!isTopFrame) {
        try { window.top.postMessage({ type: "ACLEAF_SEL", text, hasText: true }, "*"); } catch {}
      } else {
        updateFab(true);
      }

      // Show floating toolbar 450ms after selection stops moving (debounce)
      clearTimeout(toolbarTimer);
      toolbarTimer = setTimeout(() => {
        if (!savedText || !savedRange) return;
        let rect;
        try { rect = savedRange.getBoundingClientRect(); } catch { return; }
        if (rect && (rect.width > 0 || rect.height > 0)) {
          showToolbar(rect, savedText);
        }
      }, 450);

    } else if (!text) {
      clearTimeout(toolbarTimer);
      if (!isTopFrame) {
        try { window.top.postMessage({ type: "ACLEAF_SEL", text: "", hasText: false }, "*"); } catch {}
      } else {
        updateFab(false);
      }
    }
  });

  // Top frame: listen for selection messages from child frames (the PDF iframe)
  if (isTopFrame) {
    window.addEventListener("message", (e) => {
      if (e.data?.type !== "ACLEAF_SEL") return;
      if (e.data.hasText) {
        // Store which frame has the selection + what text
        updateFab(true);
        fabChildText   = e.data.text;
        fabChildSource = e.source;
      } else {
        if (fabChildSource === e.source) { fabChildText = ""; fabChildSource = null; }
        if (!savedText) updateFab(false);
      }
    });
  }

  // Child frame: listen for FAB action commands from top frame
  if (!isTopFrame) {
    window.addEventListener("message", (e) => {
      if (e.data?.type !== "ACLEAF_ACTION") return;
      const action = e.data.action;
      if (action === "highlight") highlightFromRange(savedRange, savedText);
      else if (action === "define")    handleDefine(savedText);
      else if (action === "translate") handleTranslate(savedText);
      else if (action === "dict")      handleAddToDictionary(savedText);
    });
  }

  // ── Floating toolbar ────────────────────────────────────────────────────────
  let toolbar = null;

  // Also show toolbar on mouseup as a secondary trigger (belt-and-suspenders)
  function onPointerUp(e) {
    if (toolbar?.contains(e.target)) return;
    if (!savedText || !savedRange) return;
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(() => {
      if (!savedText || !savedRange) return;
      let rect;
      try { rect = savedRange.getBoundingClientRect(); } catch { return; }
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        rect = { top: e.clientY - 2, bottom: e.clientY, left: e.clientX, right: e.clientX, width: 0, height: 0 };
      }
      showToolbar(rect, savedText);
    }, 80);
  }
  document.addEventListener("mouseup",   onPointerUp, true);
  document.addEventListener("pointerup", onPointerUp, true);

  document.addEventListener("mousedown", (e) => {
    if (toolbar && !toolbar.contains(e.target)) hideToolbar();
  }, true);

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

    toolbar.style.cssText = `position:fixed!important;left:${x}px;top:${y}px;transform:translate(-50%,${above ? "-100%" : "0"})`;
    document.documentElement.appendChild(toolbar);
    requestAnimationFrame(() => toolbar.classList.add("sr-visible"));

    toolbar.addEventListener("mousedown", e => e.stopPropagation(), true);
    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const ct = savedText; const cr = savedRange;
      hideToolbar();
      if (action === "highlight") highlightFromRange(cr, ct);
      else if (action === "define")    handleDefine(ct);
      else if (action === "translate") handleTranslate(ct);
      else if (action === "dict")      handleAddToDictionary(ct);
    });
  }

  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  // ── Corner FAB — only in top frame, talks to child frames via postMessage ───
  let fabChildText   = "";
  let fabChildSource = null;

  // Only render FAB in the top frame — child frames handle selection + toolbar only
  if (isTopFrame) setupFab();

  function setupFab() {
  const fab = createElement("div", "sr-fab", "✦");
  fab.title = "Acleaf — click after selecting text";
  document.documentElement.appendChild(fab);

  // Wire up the real updateFab into the outer scope
  updateFab = (hasSelection) => fab.classList.toggle("sr-fab-active", hasSelection);

  fab.addEventListener("click", (e) => {
    e.stopPropagation();

    // Prefer child-frame selection (PDF in iframe), fall back to top-frame selection
    const text   = fabChildText   || savedText;
    const source = fabChildSource || null;

    if (!text) {
      showToast("Select text in the PDF first.", "info");
      return;
    }

    if (source) {
      // Show a simple action picker in the top frame
      showFabMenu(text, source);
    } else {
      // Selection is in top frame — show toolbar near FAB
      const r = fab.getBoundingClientRect();
      showToolbar({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }, text);
    }
  });

  function showFabMenu(text, sourceFrame) {
    hideToolbar();
    toolbar = createElement("div", "sr-toolbar", `
      <button class="sr-tool-btn" data-action="highlight">✏️ Highlight</button>
      <button class="sr-tool-btn" data-action="define">📖 Define</button>
      <button class="sr-tool-btn" data-action="translate">🌐 Translate</button>
      <button class="sr-tool-btn" data-action="dict">📝 Dictionary</button>
    `);
    const r = fab.getBoundingClientRect();
    toolbar.style.cssText = `position:fixed!important;left:${r.left + r.width/2}px;top:${r.top - 10}px;transform:translate(-50%,-100%)`;
    document.documentElement.appendChild(toolbar);
    requestAnimationFrame(() => toolbar.classList.add("sr-visible"));

    toolbar.addEventListener("mousedown", e => e.stopPropagation(), true);
    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      hideToolbar();
      // For define/translate/dict — handle in top frame (API calls work anywhere)
      if (action === "define")    { handleDefine(text); return; }
      if (action === "translate") { handleTranslate(text); return; }
      if (action === "dict")      { handleAddToDictionary(text); return; }
      // For highlight — must run inside the child frame where the DOM lives
      if (action === "highlight") {
        try { sourceFrame.postMessage({ type: "ACLEAF_ACTION", action: "highlight" }, "*"); }
        catch { showToast("Could not highlight — try right-click → Acleaf → Highlight.", "error"); }
      }
    });
  } // end showFabMenu
  } // end setupFab

  // ── Highlight ───────────────────────────────────────────────────────────────

  function highlightFromRange(range, text) {
    // Use saved range — selection may already be gone by the time this runs
    if (!range) {
      // Fallback: try live selection
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        showToast("Could not highlight — please try again.", "error");
        return;
      }
      range = sel.getRangeAt(0);
    }
    try {
      const mark = document.createElement("mark");
      mark.className = "sr-highlight";
      mark.style.backgroundColor = settings.highlightColor;
      range.surroundContents(mark);
      window.getSelection()?.removeAllRanges();
      savedRange = null; savedText = "";
      showToast("Highlighted!", "success");
    } catch {
      try {
        const fragment = range.extractContents();
        const mark = document.createElement("mark");
        mark.className = "sr-highlight";
        mark.style.backgroundColor = settings.highlightColor;
        mark.appendChild(fragment);
        range.insertNode(mark);
        window.getSelection()?.removeAllRanges();
        savedRange = null; savedText = "";
        showToast("Highlighted!", "success");
      } catch {
        showToast("Cannot highlight here — try right-click → Acleaf → Highlight.", "error");
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
