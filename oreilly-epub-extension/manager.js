(function() {
  'use strict';

  // The manager is a full browser tab (not a transient popup), so it can build
  // the EPUB in-page and download it directly — no need to open the O'Reilly
  // site. Extension pages inherit host_permissions, so fetches to
  // learning.oreilly.com carry the session cookies (same as the catalog search).
  const API_BASE = 'https://learning.oreilly.com';

  let busy = false;

  // Combine the two-phase progress into a single percentage (images 0–30%,
  // chapters 30–100%), matching the popup's progress bar.
  function toPercent(p) {
    const imgPct = p.totalImages > 0 ? (p.images || 0) / p.totalImages : 1;
    const chPct = p.totalChapters > 0 ? (p.chapter || 0) / p.totalChapters : 0;
    return Math.round(imgPct * 30 + chPct * 70);
  }

  async function inPageDownload(book, btn) {
    if (busy) return; // one book at a time to stay under O'Reilly's rate limits
    busy = true;
    const controller = new AbortController();
    btn.disabled = true;
    btn.classList.add('downloading');
    btn.textContent = '0%';
    try {
      const { blob, filename } = await Downloader.download({
        isbn: book.isbn,
        apiBase: API_BASE,
        signal: controller.signal,
        fallbackTitle: book.title,
        onProgress: (p) => { btn.textContent = `${toPercent(p)}%`; },
      });
      Downloader.triggerBrowserDownload(blob, filename);
      btn.textContent = '✓';
      btn.classList.remove('downloading');
    } catch (e) {
      console.error('Download failed:', e);
      btn.classList.remove('downloading');
      btn.textContent = '⚠';
      btn.title = e.message === 'SESSION_EXPIRED'
        ? 'Not signed in to O\'Reilly (or session expired) — log in and retry.'
        : (e.message || 'Download failed');
      setTimeout(() => { btn.disabled = false; btn.textContent = '📥'; btn.title = 'Download EPUB'; }, 5000);
    } finally {
      busy = false;
    }
  }

  CatalogUI.init({
    topic: document.getElementById('browse-topic'),
    query: document.getElementById('browse-query'),
    btn: document.getElementById('btn-browse'),
    status: document.getElementById('browse-status'),
    results: document.getElementById('browse-results'),
    export: document.getElementById('btn-export'),
  }, { maxBooks: 500, onDownload: inPageDownload });
})();
