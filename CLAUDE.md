# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that converts O'Reilly Learning books to EPUB 3.0 format, optimized for e-ink readers. Runs entirely in the browser using the user's existing O'Reilly session — no backend server.

Two ways in:
- **Single book** — on a book page, one click exports the book you're viewing (ISBN taken from the URL).
- **Catalog browse** — the popup can list every book in a category / search term across the whole O'Reilly catalog (pages through the search API in the service worker), export the list as CSV, and download any result. Catalog "Download" opens the book's page in a new tab and auto-starts its export — the EPUB build needs a page/DOM context (DOMParser), so it can't run in the service worker.

## Running Tests

Tests run in a browser (no Node.js test runner):
```bash
# Start a local server and open the test runner
python -m http.server 8765
# Then open: http://localhost:8765/oreilly-epub-extension/tests/test-runner.html
```

The test framework is a minimal custom implementation (`describe`/`it`/`assert`) in `test-runner.html`. Test files: `tests/*.test.js`.

## Loading the Extension

1. Open `chrome://extensions/` with Developer mode enabled
2. Click "Load unpacked" → select `oreilly-epub-extension/`
3. Navigate to any book page on `learning.oreilly.com`

## Architecture

### Three-Layer Communication Model

```
Popup (UI) ←→ Service Worker (relay/state) ←→ Content Script (all work)
```

- **Content script** (`content.js`) — thin adapter on `learning.oreilly.com`. Detects the book, relays commands, and runs the shared `Downloader` engine with `apiBase=''` (same-origin fetches). Same-origin context means session cookies are included automatically.
- **Download engine** (`lib/downloader.js`) — `Downloader.download({isbn, apiBase, signal, onProgress, fallbackTitle, format})` does the manifest fetch (with empty-manifest retry), image/CSS collection, and chapter processing. With `format='epub'` (default) it assembles a ZIP and returns `{blob, filename, title}`; with `format='pdf'` it assembles one self-contained HTML document (images inlined as `data:` URLs, publisher CSS + light overrides inlined, each chapter a page-breaking `<section>`) and returns `{html, title}` for the caller to print. The PDF collection is additive and inert when `format==='epub'`. Context-agnostic: the content script calls it with `apiBase=''`; the full-page manager calls it with `apiBase='https://learning.oreilly.com'` and builds **in-page** (extension pages inherit host_permissions, so cross-origin fetches carry O'Reilly cookies — no book tab is opened). The popup can't build in-page (its window closes), so its catalog downloads still go through the background's `downloadBook` (open tab + auto-export), EPUB only.
- **PDF output** is browser print-to-PDF: the manager renders the assembled HTML in a hidden same-origin `srcdoc` iframe and calls `iframe.contentWindow.print()`, so the user saves a real, text-based PDF via Chrome's own engine (no bundled PDF library). Only offered on the full-page manager (`#format` select), not the popup.
- **Service worker** (`background.js`) — relay + CORS proxy. Forwards messages, updates badge, persists state via `chrome.storage.session` (survives MV3 service worker termination). Also acts as a CORS proxy for CDN images (`fetchImage` handler fetches in SW context, returns base64).
- **Popup** (`popup.html/js/css`) — pure UI. Queries service worker for state, displays it, sends commands. The ⤢ header button opens the full-page manager.
- **Full-page manager** (`manager.html/js/css`) — a roomy catalog browser opened in its own tab (also registered as the extension's `options_ui`). Shares the catalog-browsing logic with the popup via `lib/catalog-ui.js`; only the layout (a responsive grid of cards) differs, in CSS.

### Library Modules (loaded as content scripts, not ES modules)

All expose global objects (`Fetcher`, `EpubBuilder`, `EinkOptimizer`) — no import/export. **Load order matters**: `fetcher.js` must load before `eink-optimizer.js` (dependency on `Fetcher.parseXhtml()`).

- `lib/fetcher.js` — HTTP fetching with retry + progressive backoff. Handles both 403 and 429 as rate limits. ISBN extraction from URLs via regex. Also provides: `parseXhtml()` (XHTML parser with text/html fallback), `extractImageUrls()` (extracts `<img>`, `<image>`, `<object>` sources with deduplication), `extractCssImageUrls()` (CSS `url()` extraction), `stripQueryAndHash()`.
- `lib/epub-builder.js` — Generates EPUB structural files (content.opf, toc.xhtml, toc.ncx, container.xml, cover.xhtml). Pure string generation, no side effects.
- `lib/eink-optimizer.js` — Rewrites chapter XHTML via DOM manipulation (DOMParser + XMLSerializer): injects e-ink CSS override, remaps image paths to `../Images/`, rewrites CSS links to `../Styles/`. Uses `Fetcher.parseXhtml()` for robust parsing. Serializes back via `XMLSerializer` to avoid HTML entity mismatches.
- `lib/catalog.js` — Pure helpers for the catalog search API: `buildSearchUrl()`, `parseSearchResponse()`, `normalizeBook()`, `extractIsbn()` (defensive — reads `isbn`/`archive_id`/`identifier` or an ISBN embedded in a URL), `nextUrlFromResponse()`, and a `TOPICS` list of common categories. No fetching — `background.js` does the paging. Unlike the other lib modules it is **not** a content script; the SW pulls it in with `importScripts('lib/catalog.js')` (guarded by `typeof importScripts === 'function'` so the test runner, which loads it via `<script>`, doesn't break), and the popup loads it with a `<script>` tag.
- `lib/catalog-ui.js` — Shared catalog-browser UI factory (`CatalogUI.init(els, opts)`): wires search, result rendering, per-book download, and CSV export onto a given set of DOM elements. Used by both `popup.js` and `manager.js` so the browsing logic lives in one place; the two pages differ only in CSS layout. Emits identical `.book-row` markup. Not a content script — loaded via `<script>` in the popup and manager pages.
- `lib/jszip.min.js` — Third-party EPUB packaging.

### Key Implementation Details

- **Book metadata** comes from the search API (`/api/v2/search/?query={ISBN}&limit=1`), not DOM selectors. O'Reilly is a React SPA — DOM elements render asynchronously and are unreliable from content scripts.
- **Title fallback**: parses `document.title` (format: `"ChapterTitle | BookTitle"`) taking the last segment.
- **File manifest** is paginated — fetched in a loop following `filesData.next`.
- **Two-phase download with progress**: Phase 1 pre-downloads all manifest images (0-30% progress bar), Phase 2 processes chapters (30-100%). This keeps the progress bar moving during the entire download.
- **Four-strategy image fallback** (in `content.js`): (1) Match resolved path against pre-downloaded manifest images, (2) Match by filename only, (3) Fetch via O'Reilly API (relative URLs), (4) Fetch via background SW CORS proxy (absolute CDN URLs only).
- **CSS background images** are also extracted and downloaded from stylesheets via `Fetcher.extractCssImageUrls()`.
- **MV3 state persistence**: `chrome.storage.session` ensures popup state survives service worker termination (MV3 terminates idle SWs after ~30s).
- **Chapters fetched in batches of 2** with 1s delay between batches to avoid 403 rate limiting.
- **`mimetype` must be the first ZIP entry** with `{compression: 'STORE'}` per EPUB spec.
- **EPUB includes both EPUB 3 nav (`toc.xhtml`) and EPUB 2 NCX (`toc.ncx`)** for Boox reader compatibility.
- **Query/hash stripping**: Image URLs with `?v=123` or `#fragment` are cleaned before API requests to avoid 404s.
- **Catalog search runs in the service worker** (`searchCatalog` handler), not a content script, so it works regardless of the active tab — same-origin cookies still ride along. It pages until it hits `maxBooks` (default 200, hard cap 1000) or the last page, dedupes by ISBN, and reports `{ books, total, truncated }`. Because the search API's exact response shape is undocumented/variable, `Catalog.parseSearchResponse`/`normalizeBook` are written defensively (multiple candidate field names). If `query=*` returns nothing while browsing a topic, the loop retries once with the topic name as the query.
- **Catalog download is cross-tab**: `downloadBook` opens the book page (`active: true`) and stores the ISBN in `state.pendingDownloadIsbnByTab`; when that tab's content script fires `bookDetected`, `background.js` auto-starts the export for it. `startDownload` (content + SW) accepts an optional `isbn` so a catalog-initiated export can target a book that isn't the current URL.

## O'Reilly API Endpoints Used

- `GET /api/v2/search/?query={ISBN}&limit=1` — book metadata (title, authors)
- `GET /api/v2/search/?query={term}&formats=book&limit={n}&page={0-based}` — catalog browse/search (paginated; response parsed by `lib/catalog.js`)
- `GET /api/v2/epubs/urn:orm:book:{ISBN}/files/?limit=200` — file manifest (paginated)
- `GET /api/v2/epubs/urn:orm:book:{ISBN}/files/{path}` — individual file content

## Code Style

- Vanilla JavaScript, no build step, no frameworks
- All extension code wrapped in IIFEs (`(function() { 'use strict'; ... })()`)
- Library modules use global object pattern (e.g., `const Fetcher = { ... }`)
- Comments and code in English
