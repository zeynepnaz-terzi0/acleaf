// Acleaf - Background Service Worker

// ── Context menu setup ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "acleaf-parent",
      title: "Acleaf",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "define-word",
      parentId: "acleaf-parent",
      title: "Define \"%s\"",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "translate-word",
      parentId: "acleaf-parent",
      title: "Translate \"%s\"",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "add-to-dictionary",
      parentId: "acleaf-parent",
      title: "Add \"%s\" to My Dictionary",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "highlight-text",
      parentId: "acleaf-parent",
      title: "Highlight \"%s\"",
      contexts: ["selection"]
    });
  });
});

// ── PDF detection ────────────────────────────────────────────────────────────

function isPdfUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // Direct .pdf URL
  if (lower.endsWith(".pdf")) return true;
  // PDF in query string (e.g. ?file=doc.pdf)
  if (lower.includes(".pdf?") || lower.includes(".pdf#")) return true;
  // Common PDF viewer patterns
  const pdfPatterns = [
    /[?&]file=.*\.pdf/i,
    /[?&]pdf=/i,
    /\/pdf\//i,
    /viewer.*\.pdf/i,
    /\.pdf$/i,
    // Web-based PDF stream/viewer patterns (e.g. digilib, institutional repos)
    /[?&]p=fstream/i,
    /[?&]p=.*pdf/i,
    /fstream[-_]?pdf/i,
    /[?&]action=download.*pdf/i,
    /\/stream\//i,
    /[?&]type=pdf/i,
    /[?&]format=pdf/i,
    /[?&]doctype=pdf/i,
    /digilib.*fid=/i,
    /[?&]view=pdf/i,
    /\/bitstream\//i,
    /\/fulltext\//i,
    /jstor\.org\/stable\//i,
    /arxiv\.org\/pdf\//i,
    /sciencedirect\.com\/science\/article/i,
    /researchgate\.net\/.*publication/i
  ];
  return pdfPatterns.some(p => p.test(url));
}

// Track tabs where we already showed the save prompt
const promptedTabs = new Set();

async function handlePdfTab(tabId, url, title) {
  if (!isPdfUrl(url)) return;
  // Don't redirect if already in our viewer
  if (url.includes(chrome.runtime.getURL("viewer"))) return;
  if (promptedTabs.has(tabId)) return;
  promptedTabs.add(tabId);

  // Auto-save to Last Seen
  await addToLastSeen(url, title || url);

  // For local file:// PDFs the background can't proxy them,
  // pass them directly — the viewer will fetch them itself
  const isLocal = url.startsWith("file://");

  // Redirect to our PDF viewer where text selection works
  const viewerUrl = chrome.runtime.getURL("viewer/index.html")
    + "?url=" + encodeURIComponent(url)
    + "&title=" + encodeURIComponent(title || url)
    + (isLocal ? "&local=1" : "");
  chrome.tabs.update(tabId, { url: viewerUrl }).catch(() => {});
}

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab || !tab.url) return;
  handlePdfTab(details.tabId, tab.url, tab.title);
});

// Also watch tab URL changes (for SPAs and PDF.js viewers)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    handlePdfTab(tabId, tab.url, tab.title);
  }
});

// Clear from set when tab navigates away
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) promptedTabs.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  promptedTabs.delete(tabId);
});

// ── Context menu click handler ───────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const selectedText = info.selectionText?.trim();
  if (!selectedText || !tab?.id) return;

  // Don't send to our viewer page — it handles its own actions internally
  if (tab.url?.startsWith(chrome.runtime.getURL("viewer"))) return;

  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  switch (info.menuItemId) {
    case "define-word":      send({ type: "DEFINE_WORD",       word: selectedText }); break;
    case "translate-word":   send({ type: "TRANSLATE_WORD",    word: selectedText }); break;
    case "add-to-dictionary":send({ type: "ADD_TO_DICTIONARY", word: selectedText }); break;
    case "highlight-text":   send({ type: "HIGHLIGHT_SELECTION",word: selectedText }); break;
  }
});

// ── Message handler (from content script) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_PDF") {
    savePdf(msg.url, msg.title).then(sendResponse);
    return true;
  }
  if (msg.type === "ADD_TO_LAST_SEEN") {
    addToLastSeen(msg.url, msg.title).then(sendResponse);
    return true;
  }
  if (msg.type === "ADD_TO_DICTIONARY_BG") {
    addToDictionary(msg.word, msg.definition, msg.translation).then(sendResponse);
    return true;
  }
  if (msg.type === "FETCH_DEFINITION") {
    fetchDefinition(msg.word).then(sendResponse);
    return true;
  }
  if (msg.type === "FETCH_TRANSLATION") {
    fetchTranslation(msg.word, msg.targetLang).then(sendResponse);
    return true;
  }
  if (msg.type === "PROXY_PDF") {
    fetch(msg.url, { credentials: "include" })
      .then(r => r.arrayBuffer())
      .then(buf => {
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        sendResponse({ ok: true, b64: btoa(binary) });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ── Storage helpers ──────────────────────────────────────────────────────────

async function savePdf(url, title) {
  const { savedPdfs = [] } = await chrome.storage.local.get("savedPdfs");
  const already = savedPdfs.find(p => p.url === url);
  if (already) return { success: true, duplicate: true };

  savedPdfs.unshift({
    url,
    title: title || url,
    savedAt: Date.now()
  });

  // Keep last 500
  if (savedPdfs.length > 500) savedPdfs.length = 500;

  await chrome.storage.local.set({ savedPdfs });
  return { success: true, duplicate: false };
}

async function addToLastSeen(url, title) {
  const { lastSeen = [] } = await chrome.storage.local.get("lastSeen");

  // Move to top if already exists, otherwise insert
  const idx = lastSeen.findIndex(p => p.url === url);
  if (idx !== -1) {
    lastSeen[idx].lastOpenedAt = Date.now();
    lastSeen[idx].title = title || lastSeen[idx].title;
    // Move to front
    lastSeen.unshift(lastSeen.splice(idx, 1)[0]);
  } else {
    lastSeen.unshift({ url, title: title || url, lastOpenedAt: Date.now() });
  }

  // Keep last 50
  if (lastSeen.length > 50) lastSeen.length = 50;

  await chrome.storage.local.set({ lastSeen });
  return { success: true };
}

async function addToDictionary(word, definition = "", translation = "") {
  const { dictionary = [] } = await chrome.storage.local.get("dictionary");
  const existing = dictionary.find(e => e.word.toLowerCase() === word.toLowerCase());
  if (existing) {
    if (definition) existing.definition = definition;
    if (translation) existing.translation = translation;
    existing.updatedAt = Date.now();
  } else {
    dictionary.unshift({ word, definition, translation, addedAt: Date.now() });
  }
  await chrome.storage.local.set({ dictionary });
  return { success: true };
}

// ── API calls ────────────────────────────────────────────────────────────────

async function fetchDefinition(word) {
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    );
    if (!res.ok) return { error: "No definition found." };
    const data = await res.json();
    const entry = data[0];
    const meanings = entry.meanings?.slice(0, 2).map(m => ({
      partOfSpeech: m.partOfSpeech,
      definitions: m.definitions?.slice(0, 2).map(d => d.definition)
    }));
    const phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || "";
    return { word: entry.word, phonetic, meanings };
  } catch {
    return { error: "Could not fetch definition." };
  }
}

async function fetchTranslation(text, targetLang = "TR") {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`
    );
    if (!res.ok) return { error: "Translation failed." };
    const data = await res.json();
    return {
      translation: data.responseData?.translatedText || "",
      match: data.responseData?.match
    };
  } catch {
    return { error: "Could not fetch translation." };
  }
}
