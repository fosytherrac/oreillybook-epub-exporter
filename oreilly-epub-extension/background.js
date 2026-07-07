// Service Worker: message relay, badge, state, progress broadcast
// Uses chrome.storage.session to survive SW termination (MV3 lifecycle)

// Shared catalog helpers (search URL building + response parsing). importScripts
// only exists in the worker context; the guard keeps the browser test runner
// happy — there this file loads via a <script> tag and Catalog is provided
// separately.
if (typeof importScripts === 'function') {
  importScripts('lib/catalog.js');
}

// The service worker runs on the chrome-extension:// origin, so relative API
// paths (which the content script can use directly) must be made absolute here.
const OREILLY_ORIGIN = 'https://learning.oreilly.com';

const DEFAULT_STATE = {
  status: 'idle', // idle | downloading | complete | error
  progress: null,
  error: null,
  downloadingTabId: null,
  bookInfoByTab: {},
  // Tabs opened from the catalog that should auto-download once their content
  // script reports in: { [tabId]: isbn }
  pendingDownloadIsbnByTab: {},
};

// Start a download in a given tab, optionally targeting a specific ISBN.
// Returns false (and rolls back state) if the content script is unreachable.
async function beginDownload(tabId, isbn) {
  await setState({ downloadingTabId: tabId, status: 'downloading', progress: null, error: null });
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'startDownload', isbn });
    return true;
  } catch (err) {
    await setState({ status: 'idle', progress: null, error: null, downloadingTabId: null });
    return false;
  }
}

async function getState() {
  const result = await chrome.storage.session.get('state');
  return result.state || { ...DEFAULT_STATE };
}

async function setState(updates) {
  const current = await getState();
  const next = { ...current, ...updates };
  await chrome.storage.session.set({ state: next });
  return next;
}

async function setTabBookInfo(tabId, bookInfo) {
  if (tabId == null) return;
  const state = await getState();
  const bookInfoByTab = { ...state.bookInfoByTab, [tabId]: bookInfo };
  await chrome.storage.session.set({ state: { ...state, bookInfoByTab } });
}

async function removeTabBookInfo(tabId) {
  const state = await getState();
  const bookInfoByTab = { ...state.bookInfoByTab };
  delete bookInfoByTab[tabId];
  const pendingDownloadIsbnByTab = { ...(state.pendingDownloadIsbnByTab || {}) };
  delete pendingDownloadIsbnByTab[tabId];
  const updates = { bookInfoByTab, pendingDownloadIsbnByTab };
  if (state.downloadingTabId === tabId) {
    updates.status = 'idle';
    updates.progress = null;
    updates.error = null;
    updates.downloadingTabId = null;
    chrome.action.setBadgeText({ text: '' });
  }
  await chrome.storage.session.set({ state: { ...state, ...updates } });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Wrap async handler so sendResponse works
  (async () => {
    switch (message.action) {
      case 'getState': {
        const st = await getState();
        const tabId = message.tabId;
        sendResponse({
          status: st.status,
          progress: st.progress,
          error: st.error,
          downloadingTabId: st.downloadingTabId,
          bookInfo: tabId ? (st.bookInfoByTab[tabId] || null) : null,
          downloadingBookInfo: st.downloadingTabId
            ? (st.bookInfoByTab[st.downloadingTabId] || null)
            : null,
        });
        return;
      }

      case 'startDownload': {
        const st = await getState();
        if (st.status === 'downloading') {
          sendResponse({ ok: false, reason: 'already_downloading' });
          return;
        }
        const targetTabId = message.tabId;
        if (!targetTabId) {
          sendResponse({ ok: false, reason: 'no_tab' });
          return;
        }
        const started = await beginDownload(targetTabId, message.isbn);
        if (!started) {
          // Content script unreachable (e.g. extension reloaded, page not refreshed):
          // beginDownload already rolled state back so the UI is not stuck.
          sendResponse({ ok: false, reason: 'content_script_unreachable' });
          return;
        }
        sendResponse({ ok: true });
        return;
      }

      case 'searchCatalog': {
        // Page through the search API and collect up to maxBooks results for a
        // category/search term. Runs entirely in the SW so it works no matter
        // what tab is active (same-origin cookies come along automatically).
        const query = message.query || '';
        const topic = message.topic || '';
        const maxBooks = Math.min(message.maxBooks || 200, 1000);
        const limit = 100;
        try {
          const books = [];
          const seen = new Set();
          let total = 0;
          let page = 0;
          let effectiveQuery = query;
          let triedFallback = false;
          let url = Catalog.buildSearchUrl({ query: effectiveQuery, topic, page, limit });

          while (url && books.length < maxBooks && page < 50) {
            // url is a same-origin path (e.g. /api/v2/search/...); make it
            // absolute because the SW is not on the O'Reilly origin.
            const res = await fetch(`${OREILLY_ORIGIN}${url}`, { credentials: 'include' });
            if (res.status === 401) throw new Error('SESSION_EXPIRED');
            if (res.status === 429 || res.status === 403) throw new Error('RATE_LIMITED');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const parsed = Catalog.parseSearchResponse(json);
            total = parsed.total || total;

            // Some deployments reject query='*'. If the first page came back
            // empty while browsing a topic, retry once using the topic name as
            // the search term.
            if (parsed.books.length === 0 && page === 0 && !triedFallback &&
                topic && !(query && query.trim())) {
              triedFallback = true;
              effectiveQuery = topic;
              url = Catalog.buildSearchUrl({ query: effectiveQuery, page, limit });
              continue;
            }

            for (const b of parsed.books) {
              const key = b.isbn || b.webUrl || b.title;
              if (seen.has(key)) continue;
              seen.add(key);
              books.push(b);
              if (books.length >= maxBooks) break;
            }

            if (parsed.books.length < limit) break; // reached the last page
            page += 1;
            const next = Catalog.nextUrlFromResponse(json);
            url = next || Catalog.buildSearchUrl({ query: effectiveQuery, topic, page, limit });
            await new Promise((r) => setTimeout(r, 300)); // be gentle on the API
          }

          sendResponse({
            ok: true,
            books,
            total: Math.max(total, books.length),
            truncated: total > books.length,
          });
        } catch (err) {
          const msg = err.message === 'SESSION_EXPIRED'
            ? 'Session expired. Log in to O\'Reilly and try again.'
            : err.message === 'RATE_LIMITED'
            ? 'O\'Reilly is rate-limiting requests. Wait a moment and try again.'
            : err.message;
          sendResponse({ ok: false, error: msg });
        }
        return;
      }

      case 'downloadBook': {
        // Open the book's page in a new tab and remember to auto-start its
        // download once the content script there detects the book. The heavy
        // EPUB assembly needs a page context (DOMParser), so it must run in a
        // content script — the SW cannot build the EPUB itself.
        const isbn = message.isbn;
        let url = message.webUrl ||
          (isbn ? `https://learning.oreilly.com/library/view/-/${isbn}/` : null);
        // Guard against a site-relative URL, which chrome.tabs.create would
        // otherwise resolve against the chrome-extension:// origin.
        if (url && url.startsWith('/')) url = `${OREILLY_ORIGIN}${url}`;
        if (!isbn || !url) {
          sendResponse({ ok: false, reason: 'no_isbn' });
          return;
        }
        let tab;
        try {
          tab = await chrome.tabs.create({ url, active: true });
        } catch (err) {
          sendResponse({ ok: false, reason: 'tab_create_failed', error: err.message });
          return;
        }
        const st = await getState();
        await setState({
          pendingDownloadIsbnByTab: { ...st.pendingDownloadIsbnByTab, [tab.id]: isbn },
        });
        sendResponse({ ok: true, tabId: tab.id });
        return;
      }

      case 'cancelDownload': {
        const st = await getState();
        if (st.downloadingTabId) {
          chrome.tabs.sendMessage(st.downloadingTabId, { action: 'cancelDownload' });
        }
        await setState({ status: 'idle', progress: null, error: null, downloadingTabId: null });
        chrome.action.setBadgeText({ text: '' });
        return;
      }

      case 'bookDetected': {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          await setTabBookInfo(tabId, message.bookInfo);
          // If this tab was opened from the catalog to download a specific
          // book, kick that download off now that the page is ready.
          const st = await getState();
          const pendingIsbn = st.pendingDownloadIsbnByTab?.[tabId];
          if (pendingIsbn && st.status !== 'downloading') {
            const pending = { ...st.pendingDownloadIsbnByTab };
            delete pending[tabId];
            await setState({ pendingDownloadIsbnByTab: pending });
            await beginDownload(tabId, pendingIsbn);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      case 'progress': {
        const st = await getState();
        const progress = {
          chapter: message.chapter,
          totalChapters: message.totalChapters,
          images: message.images,
          totalImages: message.totalImages,
        };
        await setState({ status: 'downloading', progress });
        chrome.action.setBadgeText({
          text: `${message.chapter}/${message.totalChapters}`,
        });
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
        chrome.runtime.sendMessage({
          action: 'progressUpdate',
          tabId: st.downloadingTabId,
          ...progress,
        }).catch(() => {});
        return;
      }

      case 'downloadComplete': {
        const st = await getState();
        const completedTabId = st.downloadingTabId;
        await setState({ status: 'complete', downloadingTabId: null });
        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
        chrome.runtime.sendMessage({
          action: 'downloadComplete',
          tabId: completedTabId,
        }).catch(() => {});
        setTimeout(async () => {
          chrome.action.setBadgeText({ text: '' });
          await setState({ status: 'idle' });
        }, 5000);
        return;
      }

      case 'downloadError': {
        const st = await getState();
        await setState({ status: 'error', error: message.error });
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
        chrome.runtime.sendMessage({
          action: 'downloadError',
          tabId: st.downloadingTabId,
          error: message.error,
        }).catch(() => {});
        if (message.error && message.error.includes('Session expired')) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'O\'Reilly EPUB Exporter',
            message: 'Session expired. Please log in to O\'Reilly and try again.',
          });
        }
        return;
      }

      case 'fetchImage': {
        // CORS proxy: fetch image from SW context (bypasses content script CORS)
        try {
          const response = await fetch(message.url, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          // Convert to base64 for message passing (ArrayBuffer can't be sent)
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          sendResponse({ ok: true, data: btoa(binary) });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
    }
  })();
  return true; // Keep message channel open for async response
});

// Clean up per-tab state when a tab is closed (R5, R6)
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabBookInfo(tabId);
});
