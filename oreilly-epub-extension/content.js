(function() {
  'use strict';

  let abortController = null;

  // Extract book title from document.title which has format "ChapterTitle | BookTitle"
  function extractBookTitle() {
    const parts = document.title.split(' | ');
    return parts.length > 1 ? parts[parts.length - 1].trim() : document.title.trim();
  }

  // Fetch book metadata (title, authors) from O'Reilly API — used to report the
  // book to the popup on page load.
  async function fetchBookMetadata(isbn) {
    try {
      const res = await fetch(`/api/v2/search/?query=${isbn}&limit=1`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const book = data.results?.[0];
        if (book) {
          return {
            title: book.title || extractBookTitle(),
            authors: book.authors?.length ? book.authors : null,
          };
        }
      }
    } catch (e) { console.warn('Metadata fetch failed:', e); }
    return { title: extractBookTitle(), authors: null };
  }

  // Detect book on page load
  async function detectBook() {
    const isbn = Fetcher.extractIsbn(window.location.href);
    if (!isbn) return;

    const meta = await fetchBookMetadata(isbn);
    const authors = meta.authors || ['Unknown Author'];

    chrome.runtime.sendMessage({
      action: 'bookDetected',
      bookInfo: { isbn, title: meta.title, authors },
    });
  }

  // Listen for commands
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startDownload') startDownload(message.isbn);
    else if (message.action === 'cancelDownload') cancelDownload();
    else if (message.action === 'getBookInfo') {
      sendResponse({ isbn: Fetcher.extractIsbn(window.location.href) });
      return true;
    }
  });

  function cancelDownload() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  // isbnOverride lets a catalog-initiated download target a specific book even
  // if the current URL is not that book's page. Falls back to the page URL for
  // the classic "download the book I'm viewing" flow. The actual EPUB assembly
  // lives in the shared Downloader engine (apiBase='' → same-origin fetches).
  async function startDownload(isbnOverride) {
    if (abortController) return; // Already downloading
    const isbn = isbnOverride || Fetcher.extractIsbn(window.location.href);
    if (!isbn) return;

    const controller = new AbortController();
    abortController = controller;

    try {
      const { blob, filename } = await Downloader.download({
        isbn,
        apiBase: '',
        signal: controller.signal,
        fallbackTitle: extractBookTitle(),
        onProgress: (p) => chrome.runtime.sendMessage({ action: 'progress', ...p }),
      });
      Downloader.triggerBrowserDownload(blob, filename);
      chrome.runtime.sendMessage({ action: 'downloadComplete' });
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Download cancelled');
        return;
      }
      console.error('Download failed:', err);
      chrome.runtime.sendMessage({
        action: 'downloadError',
        error: err.message === 'SESSION_EXPIRED'
          ? 'Not signed in to O\'Reilly (or your session expired). Please log in and try again.'
          : err.message,
      });
    } finally {
      // Reset the reentry guard on every exit path (success, error, cancel).
      // Guard against clobbering a newer download started after a cancel.
      if (abortController === controller) abortController = null;
    }
  }

  detectBook();
})();
