# Acleaf

**Acleaf** is a Chrome extension that makes reading PDFs on the internet smarter. When you open a PDF, Acleaf loads it in its own built-in viewer — so you can highlight text, look up definitions, translate words, and build a personal dictionary, all without leaving the page.

---

## Features

| Feature | Description |
|---|---|
| 📄 **PDF Viewer** | Automatically opens PDFs in Acleaf's built-in viewer with full text layer support |
| 🕓 **Last Seen** | Every PDF you open is silently saved to a recents list |
| 🔖 **Library** | Save PDFs permanently with one click — reopen them anytime |
| ✏️ **Highlight** | Select any text and highlight it in your chosen colour |
| 📖 **Define** | Instant English definitions via Free Dictionary API |
| 🌐 **Translate** | Translate selected text to your language (default: Turkish) |
| 📝 **Dictionary** | Save words + definitions + translations to your personal list |
| ⬇️ **Export** | Export your dictionary as a CSV file |

---

## How It Works

1. You open a PDF anywhere on the internet
2. Acleaf automatically redirects it to the built-in PDF viewer
3. Select any text — a small toolbar appears above your selection
4. Choose **Highlight**, **Define**, **Translate**, or **Dictionary**
5. Open the extension popup to browse your Library, Last Seen, and Dictionary

---

## Installation

> Acleaf is not yet on the Chrome Web Store. Install it manually in Developer Mode.

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `smart reader` folder
6. The 📚 Acleaf icon will appear in your Chrome toolbar

**Supported browsers:** Chrome 105+, Edge 105+, Brave, Opera (any Chromium-based browser)

---

## Settings

Click the **⚙️** icon in the popup to:

- Change the **translation language** (Turkish, German, French, Spanish, Arabic, Chinese, Japanese, Russian, Portuguese, Italian)
- Change the **highlight colour**
- Clear your Last Seen history or all data

---

## Privacy

- All data (Library, Dictionary, Last Seen) is stored **locally** in your browser using `chrome.storage.local`
- Nothing is sent to any server except:
  - **Definition lookups** → [Free Dictionary API](https://dictionaryapi.dev) (free, no key required)
  - **Translations** → [MyMemory API](https://mymemory.translated.net) (free tier: ~5000 words/day)
- PDFs are fetched through the extension's background script to bypass CORS restrictions — they are never stored or transmitted elsewhere

---

## Tech Stack

- Chrome Extension Manifest V3
- [PDF.js](https://mozilla.github.io/pdf.js/) for in-browser PDF rendering
- Vanilla JavaScript, HTML, CSS — no frameworks or build steps

---

## Project Structure

```
acleaf/
├── manifest.json          # Extension config (MV3)
├── background.js          # Service worker: PDF detection, redirect, API proxy
├── content.js             # Injected script for non-PDF pages
├── content.css            # Styles injected into pages
├── popup.html/js/css      # Extension popup (Library, Last Seen, Dictionary)
├── viewer/
│   ├── index.html         # Built-in PDF viewer page
│   ├── viewer.js          # PDF.js rendering + text selection logic
│   └── viewer.css         # Viewer styles
└── icons/                 # Extension icons
```

---

## License

MIT
