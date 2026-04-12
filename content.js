// Acleaf - Content Script

(function () {
  if (window.__smartReaderLoaded) return;
  window.__smartReaderLoaded = true;

  // ── Settings ───────────────────────────────────────────────────────────────

  let settings = { translateLang: "TR", highlightColor: "#FFD700" };

  chrome.storage.local.get("settings", ({ settings: s }) => {
    if (s) settings = { ...settings, ...s };
  });

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

  document.addEventListener("mouseup", () => {
    clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (text && text.length > 0 && text.length < 500) {
        showToolbar(sel, text);
      } else {
        hideToolbar();
      }
    }, 200);
  });

  document.addEventListener("mousedown", (e) => {
    if (toolbar && !toolbar.contains(e.target)) {
      hideToolbar();
    }
  });

  function showToolbar(sel, text) {
    hideToolbar();

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    toolbar = createElement("div", "sr-toolbar", `
      <button class="sr-tool-btn" data-action="define" title="Define">📖 Define</button>
      <button class="sr-tool-btn" data-action="translate" title="Translate">🌐 Translate</button>
      <button class="sr-tool-btn" data-action="highlight" title="Highlight">✏️ Highlight</button>
      <button class="sr-tool-btn" data-action="dict" title="Add to Dictionary">📝 Dictionary</button>
    `);

    const x = rect.left + window.scrollX + rect.width / 2;
    const y = rect.top + window.scrollY - 8;

    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${y}px`;
    document.body.appendChild(toolbar);
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
