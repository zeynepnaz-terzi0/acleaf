// Smart Reader - Background Service Worker

// ── Context menu setup ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "smart-reader-parent",
      title: "Smart Reader",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "define-word",
      parentId: "smart-reader-parent",
      title: "Define \"%s\"",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "translate-word",
      parentId: "smart-reader-parent",
      title: "Translate \"%s\"",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "add-to-dictionary",
      parentId: "smart-reader-parent",
      title: "Add \"%s\" to My Dictionary",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "highlight-text",
      parentId: "smart-reader-parent",
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
    /\.pdf$/i
  ];
  return pdfPatterns.some(p => p.test(url));
}

// Track tabs where we already showed the save prompt
const promptedTabs = new Set();

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only

  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab || !tab.url) return;

  if (isPdfUrl(tab.url) && !promptedTabs.has(details.tabId)) {
    promptedTabs.add(details.tabId);
    // Small delay to let the page settle
    setTimeout(() => {
      chrome.tabs.sendMessage(details.tabId, {
        type: "SHOW_SAVE_PROMPT",
        url: tab.url,
        title: tab.title || tab.url
      }).catch(() => {});
    }, 1200);
  }
});

// Also watch tab URL changes (for SPAs and PDF.js viewers)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    if (isPdfUrl(tab.url) && !promptedTabs.has(tabId)) {
      promptedTabs.add(tabId);
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, {
          type: "SHOW_SAVE_PROMPT",
          url: tab.url,
          title: tab.title || tab.url
        }).catch(() => {});
      }, 1200);
    }
  }
});

// Clear from set when tab navigates away
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    promptedTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  promptedTabs.delete(tabId);
});

// ── Context menu click handler ───────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const selectedText = info.selectionText?.trim();
  if (!selectedText) return;

  switch (info.menuItemId) {
    case "define-word":
      chrome.tabs.sendMessage(tab.id, { type: "DEFINE_WORD", word: selectedText });
      break;
    case "translate-word":
      chrome.tabs.sendMessage(tab.id, { type: "TRANSLATE_WORD", word: selectedText });
      break;
    case "add-to-dictionary":
      chrome.tabs.sendMessage(tab.id, { type: "ADD_TO_DICTIONARY", word: selectedText });
      break;
    case "highlight-text":
      chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_SELECTION", word: selectedText });
      break;
  }
});

// ── Message handler (from content script) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_PDF") {
    savePdf(msg.url, msg.title).then(sendResponse);
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
