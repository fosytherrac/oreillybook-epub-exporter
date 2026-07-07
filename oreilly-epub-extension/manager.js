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

  // Render a print-ready HTML document in a hidden iframe and open the browser's
  // print dialog (where the user picks "Save as PDF"). Kept same-origin via
  // srcdoc so we can call print() on it; no scripts needed inside.
  function printToPdf(html) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    iframe.srcdoc = html;
    iframe.onload = () => {
      setTimeout(() => {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        } catch (e) {
          console.error('Print failed:', e);
        }
        // Remove well after the (modal) print dialog is dismissed.
        setTimeout(() => iframe.remove(), 60000);
      }, 400);
    };
    document.body.appendChild(iframe);
  }

  async function inPageDownload(book, btn) {
    if (busy) return; // one book at a time to stay under O'Reilly's rate limits
    busy = true;
    const format = document.getElementById('format').value;
    const controller = new AbortController();
    btn.disabled = true;
    btn.classList.add('downloading');
    btn.textContent = '0%';
    try {
      const result = await Downloader.download({
        isbn: book.isbn,
        apiBase: API_BASE,
        signal: controller.signal,
        fallbackTitle: book.title,
        format,
        onProgress: (p) => { btn.textContent = `${toPercent(p)}%`; },
      });
      if (format === 'pdf') {
        printToPdf(result.html);
        btn.textContent = '🖨';
      } else {
        Downloader.triggerBrowserDownload(result.blob, result.filename);
        btn.textContent = '✓';
      }
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

  // Fetch one page of catalog metadata (no images, just the JSON).
  async function fetchSearchPage(topic, query, page, limit, onRateLimit) {
    const url = API_BASE + Catalog.buildSearchUrl({ query, topic, page, limit });
    const res = await Fetcher._fetchWithRetry(url, { onRateLimit });
    let json;
    try { json = await res.json(); }
    catch (e) { throw new Error('SESSION_EXPIRED'); } // logged-out login page
    return Catalog.parseSearchResponse(json); // { books, total }
  }

  // Export the ENTIRE result set (every page) as a JSON file. This is the fast
  // path for "give me all the books": page 0 reports the total, so we fetch all
  // remaining pages concurrently through the adaptive pool and never touch a
  // single cover image.
  async function exportAllJson(statusEl) {
    if (busy) return;
    busy = true;
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
    const btn = document.getElementById('btn-export-all');
    if (btn) btn.disabled = true;
    const topic = document.getElementById('browse-topic').value;
    const query = document.getElementById('browse-query').value.trim();
    const label = (query || topic || 'oreilly-catalog')
      .replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'oreilly-catalog';
    const LIMIT = 100; // proven page size for the search API

    try {
      setStatus('Fetching page 1…');
      let effTopic = topic, effQuery = query;
      let first = await fetchSearchPage(effTopic, effQuery, 0, LIMIT);
      // Same fallback the background search uses: if an empty topic browse comes
      // back blank, retry using the topic name as the query.
      if (first.books.length === 0 && topic && !query) {
        effTopic = ''; effQuery = topic;
        first = await fetchSearchPage(effTopic, effQuery, 0, LIMIT);
      }

      const pageSize = first.books.length || LIMIT;
      const total = first.total || first.books.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const all = [...first.books];

      if (totalPages > 1) {
        const pageNums = [];
        for (let p = 1; p < totalPages; p++) pageNums.push(p);
        const perPage = await Downloader._adaptivePool(pageNums, async (p, idx, onRateLimit) => {
          const r = await fetchSearchPage(effTopic, effQuery, p, LIMIT, onRateLimit);
          return r.books;
        }, {
          startC: 6, minC: 1, maxC: 12,
          onProgress: (done) => setStatus(`Fetching catalog… ${done + 1}/${totalPages} pages (${all.length}+ books)`),
        });
        for (const arr of perPage) if (arr) all.push(...arr);
      }

      // Dedupe by ISBN (fall back to URL/title for entries without one).
      const seen = new Set();
      const books = [];
      for (const b of all) {
        const key = b.isbn || b.webUrl || b.title;
        if (seen.has(key)) continue;
        seen.add(key);
        books.push(b);
      }

      const payload = {
        source: 'learning.oreilly.com',
        query: query || null,
        topic: topic || null,
        total,
        count: books.length,
        exported_at: new Date().toISOString(),
        books,
      };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      Downloader.triggerBrowserDownload(blob, `${label}.json`);
      setStatus(`Exported ${books.length} of ${total} books → ${label}.json`);
    } catch (e) {
      console.error('Catalog export failed:', e);
      setStatus(e.message === 'SESSION_EXPIRED'
        ? 'Not signed in to O\'Reilly — log in and try again.'
        : `Export failed: ${e.message}`);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
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

  document.getElementById('btn-export-all')
    .addEventListener('click', () => exportAllJson(document.getElementById('browse-status')));
})();
