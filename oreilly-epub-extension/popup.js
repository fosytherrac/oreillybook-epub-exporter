(function() {
  'use strict';

  const stateEls = {
    notOreilly: document.getElementById('state-not-oreilly'),
    ready: document.getElementById('state-ready'),
    downloading: document.getElementById('state-downloading'),
    downloadingOther: document.getElementById('state-downloading-other'),
    error: document.getElementById('state-error'),
  };

  let activeTabId = null;

  function showState(name) {
    Object.values(stateEls).forEach(el => el.style.display = 'none');
    if (stateEls[name]) stateEls[name].style.display = 'block';
  }

  // Progress covers two phases: images (0-30%) and chapters (30-100%)
  function updateProgress(p) {
    const imgPct = p.totalImages > 0 ? (p.images || 0) / p.totalImages : 1;
    const chPct = p.totalChapters > 0 ? (p.chapter || 0) / p.totalChapters : 0;
    const pct = Math.round(imgPct * 30 + chPct * 70);

    document.getElementById('progress-fill').style.width = `${pct}%`;

    let label;
    if ((p.chapter || 0) === 0 && p.totalImages > 0) {
      label = `Images: ${p.images || 0}/${p.totalImages}`;
    } else {
      label = `Chapter ${p.chapter}/${p.totalChapters}`;
      if (p.totalImages > 0) label += ` · Images: ${p.images || 0}/${p.totalImages}`;
    }
    document.getElementById('progress-text').textContent = label;
  }

  function handleState(state) {
    if (!state || !state.bookInfo) {
      showState('notOreilly');
      return;
    }

    const isDownloadingThisTab = state.downloadingTabId === activeTabId;

    if (state.status === 'downloading' && isDownloadingThisTab && state.progress) {
      showState('downloading');
      updateProgress(state.progress);
    } else if (state.status === 'downloading' && !isDownloadingThisTab) {
      showState('downloadingOther');
      document.getElementById('book-title-other').textContent = state.bookInfo.title;
      document.getElementById('book-authors-other').textContent = state.bookInfo.authors.join(', ');
      document.getElementById('downloading-other-title').textContent =
        state.downloadingBookInfo ? state.downloadingBookInfo.title : 'Unknown';
    } else if (state.status === 'error' && isDownloadingThisTab) {
      showState('error');
      document.getElementById('error-text').textContent = state.error || 'Unknown error';
    } else {
      showState('ready');
      document.getElementById('book-title').textContent = state.bookInfo.title;
      document.getElementById('book-authors').textContent = state.bookInfo.authors.join(', ');
    }
  }

  // Query active tab, then fetch state for that tab
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) {
      showState('notOreilly');
      return;
    }
    activeTabId = tab.id;
    chrome.runtime.sendMessage({ action: 'getState', tabId: activeTabId }, handleState);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progressUpdate') {
      if (message.tabId === activeTabId) {
        showState('downloading');
        updateProgress(message);
      }
    } else if (message.action === 'downloadComplete' || message.action === 'downloadError') {
      // Re-query full state to correctly transition between states
      chrome.runtime.sendMessage({ action: 'getState', tabId: activeTabId }, handleState);
    }
  });

  const START_FAILURE_MESSAGES = {
    content_script_unreachable: 'Could not reach the page. Refresh the O\'Reilly tab and try again.',
    already_downloading: 'Another download is already in progress.',
    no_tab: 'No active tab found.',
  };

  function requestDownload(startLabel) {
    showState('downloading');
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').textContent = startLabel;
    chrome.runtime.sendMessage({ action: 'startDownload', tabId: activeTabId }, (response) => {
      if (response && response.ok === false) {
        showState('error');
        document.getElementById('error-text').textContent =
          START_FAILURE_MESSAGES[response.reason] || 'Could not start the download.';
      }
    });
  }

  document.getElementById('btn-download').addEventListener('click', () => requestDownload('Starting...'));

  document.getElementById('btn-cancel').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancelDownload', tabId: activeTabId });
    showState('ready');
  });

  document.getElementById('btn-retry').addEventListener('click', () => requestDownload('Retrying...'));

  // ---- Catalog browser -----------------------------------------------------

  const browseEls = {
    topic: document.getElementById('browse-topic'),
    query: document.getElementById('browse-query'),
    btn: document.getElementById('btn-browse'),
    status: document.getElementById('browse-status'),
    results: document.getElementById('browse-results'),
    export: document.getElementById('btn-export'),
  };

  let lastResults = [];
  let lastLabel = 'oreilly-books';

  // Populate the category dropdown from the shared Catalog module.
  (Catalog.TOPICS || []).forEach((topic) => {
    const opt = document.createElement('option');
    opt.value = topic;
    opt.textContent = topic;
    browseEls.topic.appendChild(opt);
  });

  function setBrowseBusy(busy) {
    browseEls.btn.disabled = busy;
    browseEls.btn.textContent = busy ? 'Listing…' : 'List books';
  }

  function renderResults(books) {
    browseEls.results.textContent = '';
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

      browseEls.results.appendChild(row);
    });
  }

  function downloadFromCatalog(book, btn) {
    if (!book.isbn) return;
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

  function doBrowse() {
    const topic = browseEls.topic.value;
    const query = browseEls.query.value.trim();
    lastLabel = (query || topic || 'oreilly-books')
      .replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'oreilly-books';

    setBrowseBusy(true);
    browseEls.results.textContent = '';
    browseEls.export.style.display = 'none';
    browseEls.status.textContent = 'Searching the catalog…';

    chrome.runtime.sendMessage(
      { action: 'searchCatalog', topic, query, maxBooks: 200 },
      (response) => {
        setBrowseBusy(false);
        if (!response || !response.ok) {
          browseEls.status.textContent = (response && response.error) || 'Search failed.';
          return;
        }
        lastResults = response.books || [];
        if (lastResults.length === 0) {
          browseEls.status.textContent = 'No books found. Try a different category or term.';
          return;
        }
        const shown = lastResults.length;
        browseEls.status.textContent = response.truncated
          ? `Showing ${shown} of ${response.total} books`
          : `${shown} book${shown === 1 ? '' : 's'} found`;
        renderResults(lastResults);
        browseEls.export.style.display = 'block';
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

  browseEls.btn.addEventListener('click', doBrowse);
  browseEls.query.addEventListener('keydown', (e) => { if (e.key === 'Enter') doBrowse(); });
  browseEls.export.addEventListener('click', exportCsv);
})();
