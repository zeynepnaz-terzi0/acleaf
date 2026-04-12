// Acleaf PDF Viewer – viewer.js
'use strict';

// ── PDF.js worker ────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Parse URL params ─────────────────────────────────────────────────────────
const params   = new URLSearchParams(window.location.search);
const pdfUrl   = params.get('url')   || '';
const pdfTitle = params.get('title') || pdfUrl || 'PDF';

// Set browser tab title
document.title = pdfTitle + ' – Acleaf';
document.getElementById('pdfTitle').textContent = pdfTitle;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const spinnerWrap       = document.getElementById('spinnerWrap');
const errorWrap         = document.getElementById('errorWrap');
const errorMsg          = document.getElementById('errorMsg');
const pagesContainer    = document.getElementById('pagesContainer');
const thumbnailContainer= document.getElementById('thumbnailContainer');
const sidebar           = document.getElementById('sidebar');
const totalPagesEl      = document.getElementById('totalPages');
const currentPageInput  = document.getElementById('currentPage');
const zoomLabel         = document.getElementById('zoomLabel');
const selToolbar        = document.getElementById('selToolbar');
const sidePanel         = document.getElementById('sidePanel');
const sidePanelTitle    = document.getElementById('sidePanelTitle');
const sidePanelBody     = document.getElementById('sidePanelBody');
const sidePanelClose    = document.getElementById('sidePanelClose');
const toast             = document.getElementById('toast');
const viewerMain        = document.getElementById('viewerMain');
const saveBtn           = document.getElementById('saveToLib');

// ── State ────────────────────────────────────────────────────────────────────
let pdfDoc       = null;
let currentScale = 1.0;
let numPages     = 0;
let renderQueue  = [];   // tracks ongoing renders to cancel on zoom change
let settings     = {};

const ZOOM_LEVELS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
let zoomIndex = 1; // default 100%

// ── Load settings ────────────────────────────────────────────────────────────
chrome.storage.local.get('settings', (result) => {
  settings = result.settings || {};
});

// ── Notify background: add to last seen ──────────────────────────────────────
if (pdfUrl) {
  chrome.runtime.sendMessage({ type: 'ADD_TO_LAST_SEEN', url: pdfUrl, title: pdfTitle })
    .catch(() => {});
}

// ── Save to Library button ───────────────────────────────────────────────────
saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = '…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'SAVE_PDF', url: pdfUrl, title: pdfTitle });
    if (resp && resp.duplicate) {
      showToast('Already in library', 'info');
    } else {
      showToast('Saved to library! 🔖', 'success');
      saveBtn.textContent = '✓ Saved';
    }
  } catch {
    showToast('Could not save', 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = '🔖 Save';
  }
});

// ── Load PDF via background proxy ────────────────────────────────────────────
async function loadPdf() {
  if (!pdfUrl) {
    showError('No PDF URL provided.');
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'PROXY_PDF', url: pdfUrl });

    if (!resp || !resp.ok) {
      throw new Error(resp?.error || 'Proxy fetch failed');
    }

    // Decode base64 → Uint8Array
    const binary = atob(resp.b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    pdfDoc = await loadingTask.promise;

    numPages = pdfDoc.numPages;
    totalPagesEl.textContent = numPages;
    currentPageInput.max = numPages;

    // Hide spinner, show pages
    spinnerWrap.hidden = true;
    pagesContainer.style.display = '';

    await renderAllPages();
    renderAllThumbnails();
    updateCurrentPageHighlight(1);

  } catch (err) {
    showError('Failed to load PDF: ' + err.message);
  }
}

// ── Render all pages ─────────────────────────────────────────────────────────
async function renderAllPages() {
  pagesContainer.innerHTML = '';

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page     = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale });

    // Wrapper
    const wrap    = document.createElement('div');
    wrap.className= 'page-wrap';
    wrap.id        = `page-${pageNum}`;
    wrap.style.width  = viewport.width  + 'px';
    wrap.style.height = viewport.height + 'px';

    // Canvas
    const canvas  = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    wrap.appendChild(canvas);

    // Text layer
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width  = viewport.width  + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    wrap.appendChild(textLayerDiv);

    pagesContainer.appendChild(wrap);

    // Render canvas
    const ctx = canvas.getContext('2d');
    const renderTask = page.render({ canvasContext: ctx, viewport });
    renderQueue.push(renderTask);
    await renderTask.promise.catch(() => {});

    // Render text layer
    const textContent = await page.getTextContent();
    pdfjsLib.renderTextLayer({
      textContent,
      container: textLayerDiv,
      viewport,
      textDivs: []
    });
  }
}

// ── Render thumbnails ────────────────────────────────────────────────────────
async function renderAllThumbnails() {
  thumbnailContainer.innerHTML = '';
  const THUMB_SCALE = 0.18;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page     = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: THUMB_SCALE });

    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    wrap.dataset.page = pageNum;

    const canvas  = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    wrap.appendChild(canvas);

    const numLabel = document.createElement('span');
    numLabel.className = 'thumb-num';
    numLabel.textContent = pageNum;
    wrap.appendChild(numLabel);

    thumbnailContainer.appendChild(wrap);

    wrap.addEventListener('click', () => scrollToPage(pageNum));

    const ctx = canvas.getContext('2d');
    page.render({ canvasContext: ctx, viewport }).promise.catch(() => {});
  }
}

// ── Scroll to a specific page ────────────────────────────────────────────────
function scrollToPage(pageNum) {
  const el = document.getElementById(`page-${pageNum}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ── Track current visible page on scroll ────────────────────────────────────
const scrollObserver = new IntersectionObserver((entries) => {
  let topEntry = null;
  for (const entry of entries) {
    if (entry.isIntersecting) {
      if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
        topEntry = entry;
      }
    }
  }
  if (topEntry) {
    const pageNum = parseInt(topEntry.target.id.replace('page-', ''), 10);
    updateCurrentPage(pageNum);
  }
}, {
  root: viewerMain,
  threshold: 0.2
});

function observePages() {
  document.querySelectorAll('.page-wrap').forEach(el => scrollObserver.observe(el));
}

function updateCurrentPage(pageNum) {
  currentPageInput.value = pageNum;
  updateCurrentPageHighlight(pageNum);
}

function updateCurrentPageHighlight(pageNum) {
  document.querySelectorAll('.thumb-wrap').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.page, 10) === pageNum);
  });
}

// Re-observe after each full render
const origRenderAllPages = renderAllPages;
async function renderAndObserve() {
  await origRenderAllPages();
  observePages();
}

// ── Navigation buttons ───────────────────────────────────────────────────────
document.getElementById('prevPage').addEventListener('click', () => {
  const cur = parseInt(currentPageInput.value, 10);
  if (cur > 1) scrollToPage(cur - 1);
});
document.getElementById('nextPage').addEventListener('click', () => {
  const cur = parseInt(currentPageInput.value, 10);
  if (cur < numPages) scrollToPage(cur + 1);
});
currentPageInput.addEventListener('change', () => {
  let v = parseInt(currentPageInput.value, 10);
  if (isNaN(v) || v < 1) v = 1;
  if (v > numPages) v = numPages;
  currentPageInput.value = v;
  scrollToPage(v);
});

// ── Zoom ─────────────────────────────────────────────────────────────────────
function applyZoom() {
  currentScale = ZOOM_LEVELS[zoomIndex];
  zoomLabel.textContent = Math.round(currentScale * 100) + '%';

  // Cancel ongoing renders
  renderQueue.forEach(t => { try { t.cancel(); } catch {} });
  renderQueue = [];

  if (pdfDoc) {
    renderAndObserve().then(() => renderAllThumbnails());
  }
}

document.getElementById('zoomIn').addEventListener('click', () => {
  if (zoomIndex < ZOOM_LEVELS.length - 1) { zoomIndex++; applyZoom(); }
});
document.getElementById('zoomOut').addEventListener('click', () => {
  if (zoomIndex > 0) { zoomIndex--; applyZoom(); }
});

// ── Sidebar toggle ───────────────────────────────────────────────────────────
document.getElementById('toggleSidebar').addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

// ── Floating selection toolbar ───────────────────────────────────────────────
let savedRange  = null;
let savedText   = '';
let toastTimer  = null;

document.addEventListener('mouseup', (e) => {
  // Don't trigger from toolbar itself
  if (selToolbar.contains(e.target) || sidePanel.contains(e.target)) return;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    hideSelToolbar();
    return;
  }

  savedText  = sel.toString().trim();
  savedRange = sel.getRangeAt(0).cloneRange();

  // Position above selection
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const tbW  = selToolbar.offsetWidth || 260;
  const tbH  = selToolbar.offsetHeight || 40;

  let left = rect.left + rect.width / 2 - tbW / 2;
  let top  = rect.top  - tbH - 8 + window.scrollY;

  // Clamp to viewport
  if (left < 6) left = 6;
  if (left + tbW > window.innerWidth - 6) left = window.innerWidth - tbW - 6;
  if (top < 6) top = rect.bottom + 8 + window.scrollY;

  selToolbar.style.left = left + 'px';
  selToolbar.style.top  = top  + 'px';
  selToolbar.classList.add('sr-visible');
});

document.addEventListener('mousedown', (e) => {
  if (!selToolbar.contains(e.target)) {
    hideSelToolbar();
  }
});

function hideSelToolbar() {
  selToolbar.classList.remove('sr-visible');
}

// ── Toolbar: Highlight ───────────────────────────────────────────────────────
document.getElementById('btnHighlight').addEventListener('click', () => {
  if (!savedRange || !savedText) return;
  hideSelToolbar();

  const color = settings?.highlightColor || '#ffd700';
  try {
    const mark = document.createElement('mark');
    mark.className = 'sr-highlight';
    mark.style.backgroundColor = color;
    mark.style.color = 'inherit';

    // Restore and surround
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);

    savedRange.surroundContents(mark);
    sel.removeAllRanges();
    showToast('Highlighted ✏️', 'success');
  } catch (err) {
    // surroundContents fails on cross-element selections – fallback
    try {
      const mark2 = document.createElement('mark');
      mark2.className = 'sr-highlight';
      mark2.style.backgroundColor = color;
      mark2.style.color = 'inherit';
      mark2.textContent = savedText;
      savedRange.deleteContents();
      savedRange.insertNode(mark2);
      showToast('Highlighted ✏️', 'success');
    } catch {
      showToast('Could not highlight selection', 'error');
    }
  }
});

// ── Toolbar: Define ──────────────────────────────────────────────────────────
document.getElementById('btnDefine').addEventListener('click', async () => {
  if (!savedText) return;
  hideSelToolbar();
  openSidePanel('Definition of "' + savedText + '"');
  sidePanelBody.innerHTML = '<p class="sr-loading">Looking up…</p>';

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'FETCH_DEFINITION', word: savedText });
    if (resp.error) {
      sidePanelBody.innerHTML = `<p class="sr-error">${resp.error}</p>`;
      return;
    }
    let html = `<p class="sr-def-word">${esc(resp.word)}</p>`;
    if (resp.phonetic) html += `<p class="sr-phonetic">${esc(resp.phonetic)}</p>`;
    for (const m of (resp.meanings || [])) {
      html += `<p class="sr-pos">${esc(m.partOfSpeech)}</p><ol class="sr-defs">`;
      for (const d of (m.definitions || [])) html += `<li>${esc(d)}</li>`;
      html += '</ol>';
    }
    sidePanelBody.innerHTML = html;
  } catch {
    sidePanelBody.innerHTML = '<p class="sr-error">Could not fetch definition.</p>';
  }
});

// ── Toolbar: Translate ───────────────────────────────────────────────────────
document.getElementById('btnTranslate').addEventListener('click', async () => {
  if (!savedText) return;
  hideSelToolbar();
  const targetLang = settings?.translateLang || 'TR';
  openSidePanel('Translation');
  sidePanelBody.innerHTML = '<p class="sr-loading">Translating…</p>';

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'FETCH_TRANSLATION',
      word: savedText,
      targetLang
    });
    if (resp.error) {
      sidePanelBody.innerHTML = `<p class="sr-error">${resp.error}</p>`;
      return;
    }
    sidePanelBody.innerHTML = `
      <p class="sr-original">${esc(savedText)}</p>
      <p class="sr-arrow">↓</p>
      <p class="sr-translated">${esc(resp.translation)}</p>
      <span class="sr-lang-badge">EN → ${esc(targetLang)}</span>
    `;
  } catch {
    sidePanelBody.innerHTML = '<p class="sr-error">Could not fetch translation.</p>';
  }
});

// ── Toolbar: Dictionary ──────────────────────────────────────────────────────
document.getElementById('btnDictionary').addEventListener('click', async () => {
  if (!savedText) return;
  hideSelToolbar();

  try {
    await chrome.runtime.sendMessage({ type: 'ADD_TO_DICTIONARY_BG', word: savedText });
    showToast(`"${savedText}" added to dictionary 📝`, 'success');
  } catch {
    showToast('Could not add to dictionary', 'error');
  }
});

// ── Side panel helpers ───────────────────────────────────────────────────────
function openSidePanel(title) {
  sidePanelTitle.textContent = title;
  sidePanel.classList.add('open');
}
sidePanelClose.addEventListener('click', () => sidePanel.classList.remove('open'));

// ── Toast helper ─────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  toast.textContent = msg;
  toast.className   = `sr-toast sr-toast-${type} sr-visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('sr-visible'), 3000);
}

// ── Error display ─────────────────────────────────────────────────────────────
function showError(msg) {
  spinnerWrap.hidden = true;
  errorWrap.hidden   = false;
  errorMsg.textContent = msg;
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  zoomLabel.textContent = Math.round(currentScale * 100) + '%';
  await loadPdf();
  // After loading, attach scroll observation
  observePages();
})();
