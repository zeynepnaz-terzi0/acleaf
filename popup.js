// Acleaf – Popup Script

document.addEventListener("DOMContentLoaded", init);

function init() {
  setupTabs();
  setupSettings();
  loadLastSeen();
  loadLibrary();
  loadDictionary();
  setupSearch();
  setupExport();
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────

function setupSettings() {
  const panel = document.getElementById("settings-panel");

  document.getElementById("btn-settings").addEventListener("click", () => {
    panel.classList.toggle("hidden");
  });
  document.getElementById("btn-settings-close").addEventListener("click", () => {
    panel.classList.add("hidden");
  });

  // Load saved settings
  chrome.storage.local.get("settings", ({ settings = {} }) => {
    if (settings.translateLang) {
      document.getElementById("setting-lang").value = settings.translateLang;
    }
    if (settings.highlightColor) {
      document.getElementById("setting-color").value = settings.highlightColor;
    }
  });

  // Save on change
  document.getElementById("setting-lang").addEventListener("change", saveSettings);
  document.getElementById("setting-color").addEventListener("change", saveSettings);

  document.getElementById("btn-clear-all").addEventListener("click", () => {
    if (confirm("Clear all saved PDFs and dictionary entries?")) {
      chrome.storage.local.set({ savedPdfs: [], dictionary: [] }, () => {
        loadLibrary();
        loadDictionary();
        panel.classList.add("hidden");
      });
    }
  });

  document.getElementById("btn-clear-lastseen-settings").addEventListener("click", () => {
    if (confirm("Clear Last Seen history?")) {
      chrome.storage.local.set({ lastSeen: [] }, () => {
        loadLastSeen();
        panel.classList.add("hidden");
      });
    }
  });
}

function saveSettings() {
  const settings = {
    translateLang: document.getElementById("setting-lang").value,
    highlightColor: document.getElementById("setting-color").value
  };
  chrome.storage.local.set({ settings });
}

// ── Last Seen ─────────────────────────────────────────────────────────────────

let allLastSeen = [];

function loadLastSeen() {
  chrome.storage.local.get("lastSeen", ({ lastSeen = [] }) => {
    allLastSeen = lastSeen;
    renderLastSeen(allLastSeen);
  });
}

function renderLastSeen(items) {
  const list = document.getElementById("lastseen-list");
  const empty = document.getElementById("lastseen-empty");

  if (items.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = items.map(pdf => `
    <div class="lib-item">
      <div class="lib-icon">🕓</div>
      <div class="lib-info">
        <div class="lib-title" title="${escHtml(pdf.title)}">${escHtml(truncate(pdf.title, 52))}</div>
        <div class="lib-url">${escHtml(truncate(pdf.url, 48))}</div>
        <div class="lib-date">${formatRelative(pdf.lastOpenedAt)}</div>
      </div>
      <div class="lib-actions">
        <button class="lib-open" data-url="${escHtml(pdf.url)}">Open</button>
        <button class="lib-save-from-ls ls-save-btn" data-url="${escHtml(pdf.url)}" data-title="${escHtml(pdf.title)}" title="Save to Library">📌</button>
        <button class="lib-delete ls-del-btn" data-url="${escHtml(pdf.url)}" title="Remove">✕</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".lib-open").forEach(btn => {
    btn.addEventListener("click", () => {
      const viewerUrl = chrome.runtime.getURL("viewer/index.html")
        + "?url="   + encodeURIComponent(btn.dataset.url)
        + "&title=" + encodeURIComponent(btn.dataset.title || btn.dataset.url);
      chrome.tabs.create({ url: viewerUrl });
    });
  });

  list.querySelectorAll(".ls-save-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "SAVE_PDF", url: btn.dataset.url, title: btn.dataset.title }, (res) => {
        btn.textContent = res?.duplicate ? "✓" : "📌✓";
        btn.disabled = true;
      });
    });
  });

  list.querySelectorAll(".ls-del-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteLastSeen(btn.dataset.url));
  });
}

function deleteLastSeen(url) {
  chrome.storage.local.get("lastSeen", ({ lastSeen = [] }) => {
    const updated = lastSeen.filter(p => p.url !== url);
    chrome.storage.local.set({ lastSeen: updated }, () => {
      allLastSeen = updated;
      renderLastSeen(filterList(allLastSeen, document.getElementById("lastseen-search").value));
    });
  });
}

// ── Library ───────────────────────────────────────────────────────────────────

let allPdfs = [];

function loadLibrary() {
  chrome.storage.local.get("savedPdfs", ({ savedPdfs = [] }) => {
    allPdfs = savedPdfs;
    renderLibrary(allPdfs);
  });
}

function renderLibrary(pdfs) {
  const list = document.getElementById("library-list");
  const empty = document.getElementById("library-empty");

  if (pdfs.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = pdfs.map((pdf, i) => `
    <div class="lib-item" data-index="${i}">
      <div class="lib-icon">📄</div>
      <div class="lib-info">
        <div class="lib-title" title="${escHtml(pdf.title)}">${escHtml(truncate(pdf.title, 55))}</div>
        <div class="lib-url">${escHtml(truncate(pdf.url, 50))}</div>
        <div class="lib-date">${formatDate(pdf.savedAt)}</div>
      </div>
      <div class="lib-actions">
        <button class="lib-open" data-url="${escHtml(pdf.url)}" data-title="${escHtml(pdf.title)}">Open</button>
        <button class="lib-delete" data-url="${escHtml(pdf.url)}" title="Remove">✕</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".lib-open").forEach(btn => {
    btn.addEventListener("click", () => {
      // Open in Acleaf viewer in a new tab so user can highlight & annotate
      const viewerUrl = chrome.runtime.getURL("viewer/index.html")
        + "?url="   + encodeURIComponent(btn.dataset.url)
        + "&title=" + encodeURIComponent(btn.dataset.title || btn.dataset.url);
      chrome.tabs.create({ url: viewerUrl });
    });
  });

  list.querySelectorAll(".lib-delete").forEach(btn => {
    btn.addEventListener("click", () => deletePdf(btn.dataset.url));
  });
}

function deletePdf(url) {
  chrome.storage.local.get("savedPdfs", ({ savedPdfs = [] }) => {
    const updated = savedPdfs.filter(p => p.url !== url);
    chrome.storage.local.set({ savedPdfs: updated }, () => {
      allPdfs = updated;
      renderLibrary(filterList(allPdfs, document.getElementById("library-search").value));
    });
  });
}

// ── Dictionary ────────────────────────────────────────────────────────────────

let allWords = [];

function loadDictionary() {
  chrome.storage.local.get("dictionary", ({ dictionary = [] }) => {
    allWords = dictionary;
    renderDictionary(allWords);
  });
}

function renderDictionary(words) {
  const list = document.getElementById("dict-list");
  const empty = document.getElementById("dict-empty");

  if (words.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = words.map(entry => `
    <div class="dict-item">
      <div class="dict-item-header">
        <span class="dict-word">${escHtml(entry.word)}</span>
        <button class="dict-delete" data-word="${escHtml(entry.word)}" title="Remove">✕</button>
      </div>
      ${entry.definition ? `<div class="dict-definition">${escHtml(entry.definition)}</div>` : ""}
      ${entry.translation ? `<span class="dict-translation">${escHtml(entry.translation)}</span>` : ""}
      <div class="dict-date">${formatDate(entry.addedAt)}</div>
    </div>
  `).join("");

  list.querySelectorAll(".dict-delete").forEach(btn => {
    btn.addEventListener("click", () => deleteWord(btn.dataset.word));
  });
}

function deleteWord(word) {
  chrome.storage.local.get("dictionary", ({ dictionary = [] }) => {
    const updated = dictionary.filter(e => e.word !== word);
    chrome.storage.local.set({ dictionary: updated }, () => {
      allWords = updated;
      renderDictionary(filterList(allWords, document.getElementById("dict-search").value, "word"));
    });
  });
}

// ── Search ────────────────────────────────────────────────────────────────────

function setupSearch() {
  document.getElementById("lastseen-search").addEventListener("input", e => {
    renderLastSeen(filterList(allLastSeen, e.target.value));
  });
  document.getElementById("library-search").addEventListener("input", e => {
    renderLibrary(filterList(allPdfs, e.target.value));
  });
  document.getElementById("dict-search").addEventListener("input", e => {
    renderDictionary(filterList(allWords, e.target.value, "word"));
  });

  document.getElementById("btn-clear-lastseen").addEventListener("click", () => {
    if (confirm("Clear Last Seen history?")) {
      chrome.storage.local.set({ lastSeen: [] }, () => {
        allLastSeen = [];
        renderLastSeen([]);
      });
    }
  });
}

function filterList(items, query, field = "title") {
  if (!query.trim()) return items;
  const q = query.toLowerCase();
  return items.filter(item => {
    const main = (item[field] || "").toLowerCase();
    const url = (item.url || "").toLowerCase();
    const def = (item.definition || "").toLowerCase();
    const trans = (item.translation || "").toLowerCase();
    return main.includes(q) || url.includes(q) || def.includes(q) || trans.includes(q);
  });
}

// ── Export ────────────────────────────────────────────────────────────────────

function setupExport() {
  document.getElementById("btn-export").addEventListener("click", exportDictionary);
}

function exportDictionary() {
  chrome.storage.local.get("dictionary", ({ dictionary = [] }) => {
    if (dictionary.length === 0) return;

    const header = "Word,Definition,Translation,Added";
    const rows = dictionary.map(e =>
      [e.word, e.definition || "", e.translation || "", new Date(e.addedAt).toLocaleDateString()]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
    const csv = [header, ...rows].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    chrome.downloads
      ? chrome.downloads.download({ url, filename: "acleaf-dictionary.csv" })
      : window.open(url);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, len) {
  return str && str.length > len ? str.slice(0, len) + "…" : str;
}

function formatDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatRelative(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return "Just now";
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  return formatDate(ts);
}
