// Shared catalog-browser UI, used by both the popup and the full-page manager.
// Given a set of DOM elements, it wires up search, result rendering, per-book
// download, and CSV export. Layout differences (compact list vs. roomy grid)
// are handled purely in each page's CSS — the markup it emits is identical.
//
// Depends on the Catalog global (lib/catalog.js) and the chrome.runtime
// messaging available on extension pages. No module system — global object,
// same pattern as the other lib modules.
const CatalogUI = {
  // els: { topic, query, btn, status, results, export }
  // opts: { maxBooks, onDownload }
  //   onDownload(book, btn) — how a 📥 click is handled. Defaults to asking the
  //   background to open the book's page and auto-export (used by the popup,
  //   which can't reliably build in its own short-lived window). The manager
  //   passes its own handler that builds the EPUB in-page.
  init(els, opts = {}) {
    const maxBooks = opts.maxBooks || 200;
    const onDownload = opts.onDownload || defaultDownload;
    let lastResults = [];
    let lastLabel = 'oreilly-books';

    function defaultDownload(book, btn) {
      btn.disabled = true;
      btn.textContent = '⏳';
      chrome.runtime.sendMessage(
        { action: 'downloadBook', isbn: book.isbn, webUrl: book.webUrl, title: book.title },
        (response) => {
          if (response && response.ok) {
            btn.textContent = '✓';
          } else {
            btn.disabled = false;
            btn.textContent = '📥';
          }
        }
      );
    }

    // Populate the category dropdown from the shared Catalog module.
    (Catalog.TOPICS || []).forEach((topic) => {
      const o = document.createElement('option');
      o.value = topic;
      o.textContent = topic;
      els.topic.appendChild(o);
    });

    function setBusy(busy) {
      els.btn.disabled = busy;
      els.btn.textContent = busy ? 'Listing…' : 'List books';
    }

    function downloadFromCatalog(book, btn) {
      if (!book.isbn) return;
      onDownload(book, btn);
    }

    function renderResults(books) {
      els.results.textContent = '';
      books.forEach((book) => {
        const row = document.createElement('div');
        row.className = 'book-row';

        if (book.coverUrl) {
          const img = document.createElement('img');
          img.className = 'book-cover';
          img.src = book.coverUrl;
          img.alt = '';
          img.loading = 'lazy';
          img.addEventListener('error', () => img.remove());
          row.appendChild(img);
        }

        const info = document.createElement('div');
        info.className = 'book-row-info';

        const title = document.createElement('div');
        title.className = 'book-row-title';
        title.textContent = book.title;
        title.title = book.title;
        info.appendChild(title);

        if (book.authors && book.authors.length) {
          const authors = document.createElement('div');
          authors.className = 'book-row-authors';
          authors.textContent = book.authors.join(', ');
          info.appendChild(authors);
        }
        if (book.publisher || book.issued) {
          const meta = document.createElement('div');
          meta.className = 'book-row-meta';
          meta.textContent = [book.publisher, book.issued].filter(Boolean).join(' · ');
          info.appendChild(meta);
        }
        row.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'book-row-actions';

        const dl = document.createElement('button');
        dl.className = 'book-row-btn';
        dl.textContent = '📥';
        dl.title = book.isbn ? 'Download EPUB' : 'No ISBN available';
        dl.disabled = !book.isbn;
        dl.addEventListener('click', () => downloadFromCatalog(book, dl));
        actions.appendChild(dl);

        if (book.webUrl) {
          const open = document.createElement('a');
          open.className = 'book-row-btn';
          open.textContent = '↗';
          open.title = 'Open on O\'Reilly';
          open.href = book.webUrl;
          open.target = '_blank';
          open.rel = 'noopener';
          actions.appendChild(open);
        }
        row.appendChild(actions);

        els.results.appendChild(row);
      });
    }

    function doBrowse() {
      const topic = els.topic.value;
      const query = els.query.value.trim();
      lastLabel = (query || topic || 'oreilly-books')
        .replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'oreilly-books';

      setBusy(true);
      els.results.textContent = '';
      els.export.style.display = 'none';
      els.status.textContent = 'Searching the catalog…';

      chrome.runtime.sendMessage(
        { action: 'searchCatalog', topic, query, maxBooks },
        (response) => {
          setBusy(false);
          if (!response || !response.ok) {
            els.status.textContent = (response && response.error) || 'Search failed.';
            return;
          }
          lastResults = response.books || [];
          if (lastResults.length === 0) {
            els.status.textContent = 'No books found. Try a different category or term.';
            return;
          }
          const shown = lastResults.length;
          els.status.textContent = response.truncated
            ? `Showing ${shown} of ${response.total} books`
            : `${shown} book${shown === 1 ? '' : 's'} found`;
          renderResults(lastResults);
          els.export.style.display = '';
        }
      );
    }

    function exportCsv() {
      if (!lastResults.length) return;
      const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const header = ['Title', 'Authors', 'ISBN', 'Publisher', 'Issued', 'URL'];
      const rows = lastResults.map((b) =>
        [b.title, (b.authors || []).join('; '), b.isbn || '', b.publisher || '', b.issued || '', b.webUrl || '']
          .map(esc).join(',')
      );
      const csv = [header.map(esc).join(','), ...rows].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${lastLabel}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    els.btn.addEventListener('click', doBrowse);
    els.query.addEventListener('keydown', (e) => { if (e.key === 'Enter') doBrowse(); });
    els.export.addEventListener('click', exportCsv);
  },
};
