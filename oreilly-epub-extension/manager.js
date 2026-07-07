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

  // Fetch EVERY page of catalog metadata for the current topic/query and return
  // { books, total, query, topic }. page 0 reports the total, so the remaining
  // pages are fetched concurrently through the adaptive pool — no cover images.
  // Shared by the JSON export and the local-index build.
  async function fetchAllBooks(setStatus) {
    const topic = document.getElementById('browse-topic').value;
    const query = document.getElementById('browse-query').value.trim();
    setStatus('Fetching page 1…');
    let effTopic = topic, effQuery = query;

    // Probe a large page size; adopt it only if O'Reilly actually returns that
    // many (otherwise paging by the requested offset could skip records).
    const PROBE = 500, SAFE = 100;
    let LIMIT = SAFE;
    let first = null;
    try {
      first = await fetchSearchPage(effTopic, effQuery, 0, PROBE);
      if (first.books.length === PROBE) LIMIT = PROBE;
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') throw e;
      first = null;
    }
    if (LIMIT === SAFE && (!first || (first.total && first.books.length < first.total))) {
      first = await fetchSearchPage(effTopic, effQuery, 0, SAFE);
    }
    if (first.books.length === 0 && topic && !query) {
      effTopic = ''; effQuery = topic;
      first = await fetchSearchPage(effTopic, effQuery, 0, LIMIT);
    }

    const total = first.total || first.books.length;
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const all = [...first.books];

    if (totalPages > 1 && all.length < total) {
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

    const seen = new Set();
    const books = [];
    for (const b of all) {
      const key = b.isbn || b.webUrl || b.title;
      if (seen.has(key)) continue;
      seen.add(key);
      books.push(b);
    }
    return { books, total, query, topic };
  }

  // Export the current query's full result set as a JSON file.
  async function exportAllJson(statusEl) {
    if (busy) return;
    busy = true;
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
    const btn = document.getElementById('btn-export-all');
    if (btn) btn.disabled = true;
    try {
      const { books, total, query, topic } = await fetchAllBooks(setStatus);
      const label = (query || topic || 'oreilly-catalog')
        .replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'oreilly-catalog';
      const payload = {
        source: 'learning.oreilly.com',
        query: query || null, topic: topic || null,
        total, count: books.length, exported_at: new Date().toISOString(), books,
      };
      Downloader.triggerBrowserDownload(
        new Blob([JSON.stringify(payload)], { type: 'application/json' }), `${label}.json`);
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

  // ---- Bulk download queue: run many books sequentially, EPUB only ----
  const BulkQueue = (function () {
    const els = {
      panel: document.getElementById('queue-panel'),
      count: document.getElementById('queue-count'),
      start: document.getElementById('btn-queue-start'),
      stop: document.getElementById('btn-queue-stop'),
      retry: document.getElementById('btn-queue-retry'),
      clear: document.getElementById('btn-queue-clear'),
      fill: document.getElementById('queue-progress-fill'),
      status: document.getElementById('queue-status'),
      list: document.getElementById('queue-list'),
    };
    const items = [];         // { isbn, title, webUrl, status, pct, error, el, badge }
    const byIsbn = new Map();
    let processing = false;
    let stopRequested = false;
    let controller = null;

    const badge = (it) => it.status === 'pending' ? '⏳'
      : it.status === 'active' ? `${it.pct || 0}%`
      : it.status === 'done' ? '✓' : '⚠';

    function refreshHeader() {
      const done = items.filter((i) => i.status === 'done').length;
      const failed = items.filter((i) => i.status === 'failed').length;
      els.panel.style.display = items.length ? '' : 'none';
      els.count.textContent = items.length
        ? `— ${items.length} book${items.length === 1 ? '' : 's'}` +
          (done || failed ? ` (${done} done${failed ? ', ' + failed + ' failed' : ''})` : '')
        : '';
      els.fill.style.width = `${items.length ? Math.round((done + failed) / items.length * 100) : 0}%`;
      els.retry.style.display = (!processing && failed > 0) ? '' : 'none';
    }

    function renderItem(it) {
      const row = document.createElement('div');
      row.className = 'queue-item status-' + it.status;
      const t = document.createElement('span');
      t.className = 'queue-item-title'; t.textContent = it.title; t.title = it.title;
      const b = document.createElement('span');
      b.className = 'queue-item-badge'; b.textContent = badge(it);
      const x = document.createElement('button');
      x.className = 'queue-item-x'; x.textContent = '✕'; x.title = 'Remove';
      x.addEventListener('click', () => remove(it.isbn));
      row.append(t, b, x);
      it.el = row; it.badge = b;
      return row;
    }

    function setStatus(it, status, pct, error) {
      it.status = status;
      if (pct != null) it.pct = pct;
      if (error != null) it.error = error;
      if (it.el) it.el.className = 'queue-item status-' + status;
      if (it.badge) { it.badge.textContent = badge(it); if (error) it.badge.title = error; }
    }

    function add(book) {
      if (!book.isbn || byIsbn.has(book.isbn)) return false;
      const it = { isbn: book.isbn, title: book.title, webUrl: book.webUrl, status: 'pending', pct: 0 };
      items.push(it);
      byIsbn.set(book.isbn, it);
      els.list.appendChild(renderItem(it));
      refreshHeader();
      return true;
    }

    function remove(isbn) {
      const it = byIsbn.get(isbn);
      if (!it || it.status === 'active') return; // never yank the in-flight one
      items.splice(items.indexOf(it), 1);
      byIsbn.delete(isbn);
      if (it.el) it.el.remove();
      refreshHeader();
    }

    function queuePct(p) {
      const imgPct = p.totalImages > 0 ? (p.images || 0) / p.totalImages : 1;
      const chPct = p.totalChapters > 0 ? (p.chapter || 0) / p.totalChapters : 0;
      return Math.round(imgPct * 30 + chPct * 70);
    }

    async function start() {
      if (processing) return;
      if (!items.some((i) => i.status === 'pending' || i.status === 'failed')) {
        els.status.textContent = 'Nothing to download.'; return;
      }
      processing = true; stopRequested = false; busy = true;
      els.start.style.display = 'none'; els.stop.style.display = '';
      els.clear.disabled = true; els.retry.style.display = 'none';

      let first = true;
      for (const it of items) {
        if (stopRequested) break;
        if (it.status !== 'pending' && it.status !== 'failed') continue;
        if (!first) await new Promise((r) => setTimeout(r, 1200)); // gentle gap between books
        first = false;
        if (stopRequested) break;

        setStatus(it, 'active', 0);
        if (it.el) it.el.scrollIntoView({ block: 'nearest' });
        controller = new AbortController();
        try {
          // Bulk is EPUB only — PDF would open a modal print dialog per book.
          const res = await Downloader.download({
            isbn: it.isbn, apiBase: API_BASE, signal: controller.signal,
            fallbackTitle: it.title, format: 'epub',
            onProgress: (p) => setStatus(it, 'active', queuePct(p)),
          });
          Downloader.triggerBrowserDownload(res.blob, res.filename);
          setStatus(it, 'done', 100);
        } catch (e) {
          if (e.name === 'AbortError') { setStatus(it, 'pending', 0); break; }
          console.warn('Queue item failed:', it.isbn, e);
          setStatus(it, 'failed', 0, e.message);
        }
        const d = items.filter((i) => i.status === 'done').length;
        els.status.textContent = `Downloading… ${d}/${items.length} done`;
        refreshHeader();
      }

      processing = false; busy = false; controller = null;
      els.start.style.display = ''; els.stop.style.display = 'none'; els.clear.disabled = false;
      refreshHeader();
      const d = items.filter((i) => i.status === 'done').length;
      const f = items.filter((i) => i.status === 'failed').length;
      els.status.textContent = stopRequested
        ? `Stopped — ${d} done, ${f} failed, ${items.length - d - f} left.`
        : `Finished — ${d} done${f ? ', ' + f + ' failed' : ''}.`;
    }

    els.start.addEventListener('click', start);
    els.stop.addEventListener('click', () => { stopRequested = true; if (controller) controller.abort(); });
    els.clear.addEventListener('click', () => {
      if (processing) return;
      items.length = 0; byIsbn.clear();
      els.list.textContent = ''; els.status.textContent = '';
      refreshHeader();
    });
    els.retry.addEventListener('click', () => {
      items.forEach((it) => { if (it.status === 'failed') setStatus(it, 'pending', 0); });
      refreshHeader(); start();
    });

    return {
      add,
      addMany(books) {
        let n = 0;
        for (const b of books) if (add(b)) n++;
        els.status.textContent = n ? `Added ${n} to the queue.` : 'Those are already queued.';
        return n;
      },
    };
  })();

  // ---- Local catalog index: instant, offline search over stored metadata ----
  const LocalIndex = (function () {
    const els = {
      status: document.getElementById('index-status'),
      build: document.getElementById('btn-build-index'),
      importBtn: document.getElementById('btn-import-index'),
      file: document.getElementById('file-import'),
      clear: document.getElementById('btn-clear-index'),
      search: document.getElementById('local-search'),
      searchStatus: document.getElementById('local-status'),
      results: document.getElementById('local-results'),
      more: document.getElementById('btn-local-more'),
      queueAll: document.getElementById('btn-queue-all'),
    };
    const PAGE = 60;
    let books = [];      // normalized + a lowercase `_s` search field, title-sorted
    let filtered = [];
    let shown = 0;
    let searchTimer = null;

    const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } };

    // Normalize an arbitrary imported/fetched record and precompute a search key.
    function prep(rawBooks) {
      return rawBooks.map((b) => {
        const isbn = b.isbn || (b.webUrl ? (String(b.webUrl).match(/(\d{13})/) || [])[1] : null) || null;
        const authors = Array.isArray(b.authors) ? b.authors : (b.authors ? [b.authors] : []);
        const o = {
          isbn,
          title: b.title || 'Untitled',
          authors,
          publisher: b.publisher || '',
          issued: b.issued || '',
          coverUrl: b.coverUrl || '',
          webUrl: b.webUrl || (isbn ? `https://learning.oreilly.com/library/view/-/${isbn}/` : null),
        };
        o._s = `${o.title} ${authors.join(' ')} ${o.publisher} ${isbn || ''}`.toLowerCase();
        return o;
      }).sort((a, b) => a.title.localeCompare(b.title));
    }

    function setStored(rawBooks, updatedAt) {
      books = prep(rawBooks);
      els.search.disabled = books.length === 0;
      els.clear.style.display = books.length ? '' : 'none';
      els.status.textContent = books.length
        ? `${books.length.toLocaleString()} books indexed${updatedAt ? ' · updated ' + fmtDate(updatedAt) : ''}`
        : 'No index yet.';
      runSearch();
    }

    function render() {
      const slice = filtered.slice(0, shown);
      CatalogUI.renderBooks(els.results, slice, inPageDownload, {
        onQueue: (book, btn) => { if (BulkQueue.add(book)) { btn.textContent = '✓'; btn.disabled = true; } },
      });
      els.more.style.display = filtered.length > shown ? '' : 'none';
      const withIsbn = filtered.filter((b) => b.isbn).length;
      els.queueAll.style.display = withIsbn ? '' : 'none';
      els.queueAll.textContent = `＋ Queue all ${withIsbn.toLocaleString()} matches`;
      els.searchStatus.textContent = filtered.length
        ? `${filtered.length.toLocaleString()} match${filtered.length === 1 ? '' : 'es'} (showing ${slice.length})`
        : (books.length ? 'No matches.' : '');
    }

    function runSearch() {
      const toks = els.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      filtered = toks.length ? books.filter((b) => toks.every((t) => b._s.includes(t))) : books;
      shown = PAGE;
      render();
    }

    async function persist(rawBooks, m) {
      const updatedAt = new Date().toISOString();
      await CatalogStore.save({ books: rawBooks, total: m.total, query: m.query, topic: m.topic, updatedAt });
      setStored(rawBooks, updatedAt);
    }

    async function build() {
      if (busy) return;
      busy = true;
      els.build.disabled = true;
      try {
        const { books: fetched, total, query, topic } = await fetchAllBooks((t) => { els.status.textContent = t; });
        await persist(fetched, { total, query, topic });
      } catch (e) {
        console.error('Build index failed:', e);
        els.status.textContent = e.message === 'SESSION_EXPIRED'
          ? 'Not signed in to O\'Reilly — log in and retry.'
          : `Build failed: ${e.message}`;
      } finally {
        busy = false;
        els.build.disabled = false;
      }
    }

    async function importFile(file) {
      try {
        const json = JSON.parse(await file.text());
        const arr = Array.isArray(json) ? json : (json.books || []);
        if (!arr.length) { els.status.textContent = 'That file had no books.'; return; }
        await persist(arr, { total: json.total || arr.length, query: json.query || null, topic: json.topic || null });
      } catch (e) {
        console.error('Import failed:', e);
        els.status.textContent = `Import failed: ${e.message}`;
      }
    }

    async function clear() {
      try { await CatalogStore.clear(); } catch (e) { /* ignore */ }
      books = []; filtered = []; shown = 0;
      els.search.value = ''; els.search.disabled = true;
      els.clear.style.display = 'none';
      els.results.textContent = ''; els.searchStatus.textContent = '';
      els.more.style.display = 'none';
      els.status.textContent = 'No index yet.';
    }

    els.build.addEventListener('click', build);
    els.importBtn.addEventListener('click', () => els.file.click());
    els.file.addEventListener('change', () => { if (els.file.files[0]) importFile(els.file.files[0]); els.file.value = ''; });
    els.clear.addEventListener('click', clear);
    els.search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
    els.more.addEventListener('click', () => { shown += PAGE; render(); });
    els.queueAll.addEventListener('click', () => {
      const n = BulkQueue.addMany(filtered.filter((b) => b.isbn));
      els.searchStatus.textContent = `Queued ${n} book${n === 1 ? '' : 's'} for download.`;
    });

    return {
      async load() {
        try {
          const rec = await CatalogStore.load();
          if (rec && Array.isArray(rec.books)) setStored(rec.books, rec.updatedAt);
        } catch (e) { console.warn('Index load failed:', e); }
      },
    };
  })();

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

  LocalIndex.load();
})();
