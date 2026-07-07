// EPUB download engine — runs in any document context (the O'Reilly content
// script OR an extension page like the full-page manager), because it only
// needs DOMParser/XMLSerializer (via Fetcher/EinkOptimizer) and fetch.
//
// The only environment difference is the API origin:
//   - content script on learning.oreilly.com → apiBase = '' (same-origin paths)
//   - extension page (manager) → apiBase = 'https://learning.oreilly.com'
//     (absolute; cookies + CORS are granted by host_permissions, same as the
//      background search)
//
// Progress is reported through an onProgress callback so each caller can render
// it however it likes; the engine returns a Blob and the caller triggers the
// browser download. Global object, same pattern as the other lib modules.
const Downloader = {
  // Fetch an absolute (CDN) image through the background SW CORS proxy.
  _fetchImageViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchImage', url }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response || !response.ok) return reject(new Error(response?.error || 'Background fetch failed'));
        const binary = atob(response.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        resolve(bytes.buffer);
      });
    });
  },

  // Fetch every page of a book's file manifest (the API is paginated).
  async loadManifest(apiBase, isbn, signal) {
    const allFiles = [];
    let nextPath = `/api/v2/epubs/urn:orm:book:${isbn}/files/?limit=200`;
    while (nextPath) {
      const filesRes = await fetch(`${apiBase}${nextPath}`, { credentials: 'include', signal });
      if (filesRes.status === 401) throw new Error('SESSION_EXPIRED');
      if (!filesRes.ok) throw new Error(`Manifest fetch failed: ${filesRes.status}`);
      // Logged out, O'Reilly may 200-redirect to a login page (HTML, not JSON).
      // Treat an unparseable manifest as a sign-in problem, not a crash.
      let filesData;
      try {
        filesData = await filesRes.json();
      } catch (e) {
        throw new Error('SESSION_EXPIRED');
      }
      const results = filesData.results || filesData;
      allFiles.push(...(Array.isArray(results) ? results : []));
      if (filesData.next) {
        const u = new URL(filesData.next);
        nextPath = u.pathname + u.search; // re-prefixed with apiBase next loop
      } else {
        nextPath = null;
      }
    }
    return allFiles;
  },

  // Split a manifest into chapter / CSS / image buckets (URLs prefixed).
  classifyFiles(apiBase, isbn, allFiles) {
    const chapterFiles = [];
    const cssFiles = [];
    const imageFiles = [];
    for (const file of allFiles) {
      const path = file.full_path || file.filename || '';
      const kind = file.kind || '';
      const mediaType = file.media_type || '';
      const contentUrl = `${apiBase}/api/v2/epubs/urn:orm:book:${isbn}/files/${path}`;

      if (kind === 'chapter' || mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
        chapterFiles.push({ path, url: contentUrl });
      } else if (mediaType === 'text/css' || path.match(/\.css$/i)) {
        cssFiles.push({ path, url: contentUrl });
      } else if (mediaType.startsWith('image/') || path.match(/\.(png|jpe?g|gif|svg|webp)$/i)) {
        imageFiles.push({ path, url: contentUrl, mediaType });
      }
    }
    return { chapterFiles, cssFiles, imageFiles };
  },

  // Book title/authors from the search API, falling back to a caller-supplied title.
  async fetchBookMetadata(apiBase, isbn, fallbackTitle) {
    try {
      const res = await fetch(`${apiBase}/api/v2/search/?query=${isbn}&limit=1`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const book = data.results?.[0];
        if (book) {
          return {
            title: book.title || fallbackTitle,
            authors: book.authors?.length ? book.authors : null,
          };
        }
      }
    } catch (e) { console.warn('Metadata fetch failed:', e); }
    return { title: fallbackTitle, authors: null };
  },

  // Trigger a browser download of a Blob (works in content script and pages).
  triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  // Adaptive-concurrency worker pool (AIMD, TCP-style congestion control).
  // Keeps `concurrency` requests in flight; additively increases while requests
  // succeed and halves the moment a worker reports a rate limit (via the
  // onRateLimit passed to it), converging just under O'Reilly's real ceiling.
  // Returns results in item order (index-aligned); a worker that throws yields
  // null for that item, except AbortError/SESSION_EXPIRED which fail the pool.
  _adaptivePool(items, worker, { startC = 4, minC = 1, maxC = 8, signal, onProgress } = {}) {
    if (!items.length) return Promise.resolve([]);
    const results = new Array(items.length);
    let concurrency = Math.min(startC, maxC);
    let active = 0, next = 0, done = 0, streak = 0, fatal = null;

    const onRateLimit = () => {                 // multiplicative decrease
      concurrency = Math.max(minC, Math.floor(concurrency / 2));
      streak = 0;
    };

    return new Promise((resolve, reject) => {
      const pump = () => {
        if (fatal) { if (active === 0) reject(fatal); return; }
        if (signal && signal.aborted) {
          fatal = new DOMException('Aborted', 'AbortError');
          if (active === 0) reject(fatal);
          return;
        }
        if (done === items.length) { resolve(results); return; }
        while (active < concurrency && next < items.length) {
          const k = next++;
          active++;
          Promise.resolve()
            .then(() => worker(items[k], k, onRateLimit))
            .then((r) => {
              results[k] = r;
              streak++;
              if (streak >= concurrency && concurrency < maxC) { concurrency++; streak = 0; } // additive increase
            })
            .catch((e) => {
              if (e && (e.name === 'AbortError' || e.message === 'SESSION_EXPIRED')) fatal = e;
              results[k] = null;
            })
            .finally(() => {
              active--;
              done++;
              if (onProgress) onProgress(done, items.length);
              pump();
            });
        }
      };
      pump();
    });
  },

  // Build a book for `isbn`.
  //   format 'epub' (default) → returns { blob, filename, title }
  //   format 'pdf'            → returns { html, title } — a single print-ready
  //                             HTML document with all assets inlined, which the
  //                             caller prints to PDF via the browser.
  // opts: { isbn, apiBase='', signal, onProgress, fallbackTitle, format }
  async download({ isbn, apiBase = '', signal, onProgress = () => {}, fallbackTitle = '', format = 'epub' }) {
    const zip = new JSZip();

    // PDF collection: alongside the ZIP writes we keep image bytes, CSS text,
    // and processed chapter HTML so we can assemble one inlined document. All of
    // this is inert when format==='epub'.
    const collectPdf = format === 'pdf';
    const pdfImages = {};   // zip filename -> { buffer, mime }
    const cssTexts = [];    // publisher CSS (url() already rewritten to ../Images/)
    const chapterHtmls = []; // { title, xhtml } in reading order
    let einkCss = '';
    const putImage = (name, buffer, mime) => {
      zip.file(`OEBPS/Images/${name}`, buffer);
      if (collectPdf) pdfImages[name] = { buffer, mime: mime || EpubBuilder._mimeType(name) };
    };

    // Fetch pacing is handled by _adaptivePool (AIMD concurrency): it keeps the
    // pipe full, ramps concurrency up while requests succeed, and halves the
    // in-flight count the moment O'Reilly returns a 403/429 — converging just
    // under the real limit instead of bursting into it. Fetcher's per-request
    // retry/backoff recovers the individual rejected requests.

    // Load + classify the manifest, retrying while it comes back empty. A
    // just-opened reader session can briefly return an empty manifest; trusting
    // the first response produced blank EPUBs. Real fetch errors propagate.
    const MAX_MANIFEST_ATTEMPTS = 6;
    let allFiles = [];
    let chapterFiles = [];
    let cssFiles = [];
    let imageFiles = [];
    for (let attempt = 1; attempt <= MAX_MANIFEST_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      allFiles = await this.loadManifest(apiBase, isbn, signal);
      ({ chapterFiles, cssFiles, imageFiles } = this.classifyFiles(apiBase, isbn, allFiles));
      console.log(`Manifest attempt ${attempt}: ${allFiles.length} files, ${chapterFiles.length} chapters`);
      if (chapterFiles.length > 0) break;
      if (attempt < MAX_MANIFEST_ATTEMPTS) await new Promise(r => setTimeout(r, 1500));
    }
    if (chapterFiles.length === 0) {
      console.error('No chapters found. Manifest sample:', allFiles.slice(0, 3));
      throw new Error(
        `No readable chapters found (manifest had ${allFiles.length} files). ` +
        `Try again in a few seconds, or the book may use an unexpected format.`
      );
    }

    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', EpubBuilder.generateContainer());

    const einkRes = await fetch(chrome.runtime.getURL('styles/eink-override.css'));
    einkCss = await einkRes.text();
    zip.file('OEBPS/Styles/eink-override.css', einkCss);

    const uniqueFilename = PathUtils.createUniqueNamer();

    const cssFilenames = [];
    const cssImageMap = {};
    for (const cssFile of cssFiles) {
      try {
        const res = await Fetcher._fetchWithRetry(cssFile.url, { signal });
        let cssText = await res.text();
        const filename = uniqueFilename(cssFile.path.split('/').pop());
        cssFilenames.push(filename);

        const cssImgUrls = Fetcher.extractCssImageUrls(cssText);
        for (const cssImgUrl of cssImgUrls) {
          if (cssImageMap[cssImgUrl]) continue;
          const cleanUrl = Fetcher.stripQueryAndHash(cssImgUrl);
          const cssDir = cssFile.path.substring(0, cssFile.path.lastIndexOf('/'));
          const resolvedPath = PathUtils.normalizePath(cssDir + '/' + cleanUrl);
          const imgName = uniqueFilename(Fetcher.stripQueryAndHash(cleanUrl.split('/').pop()));
          const apiUrl = `${apiBase}/api/v2/epubs/urn:orm:book:${isbn}/files/${Fetcher.stripQueryAndHash(resolvedPath)}`;
          try {
            const imgRes = await Fetcher._fetchWithRetry(apiUrl, { signal });
            putImage(imgName, await imgRes.arrayBuffer());
            cssImageMap[cssImgUrl] = imgName;
          } catch (e) {
            console.warn(`CSS background image fetch failed: ${cssImgUrl}`, e);
          }
        }

        for (const [original, newName] of Object.entries(cssImageMap)) {
          cssText = cssText.split(original).join(`../Images/${newName}`);
        }
        zip.file(`OEBPS/Styles/${filename}`, cssText);
        if (collectPdf) cssTexts.push(cssText);
      } catch (e) { console.warn(`CSS fetch failed: ${cssFile.path}`, e); }
    }

    // --- Phase 1: pre-download manifest images ---
    const totalChapters = chapterFiles.length;
    const manifestImageMap = {};
    const imageMap = {};
    let downloadedImageCount = 0;

    // Fetch image bytes with the adaptive pool, then assign names + write
    // sequentially so ZIP filenames are deterministic (independent of the order
    // requests happen to complete in).
    const imageBuffers = await this._adaptivePool(imageFiles, async (imgFile, idx, onRateLimit) => {
      const res = await Fetcher._fetchWithRetry(imgFile.url, { signal, onRateLimit });
      return await res.arrayBuffer();
    }, {
      startC: 6, minC: 1, maxC: 12, signal,
      onProgress: (d) => onProgress({ chapter: 0, totalChapters, images: d, totalImages: imageFiles.length }),
    });

    for (let k = 0; k < imageFiles.length; k++) {
      const buf = imageBuffers[k];
      if (!buf) continue; // failed fetches are non-fatal (image simply omitted)
      const imgFile = imageFiles[k];
      const normalizedPath = PathUtils.normalizePath(imgFile.path);
      const rawFilename = Fetcher.stripQueryAndHash(normalizedPath.split('/').pop());
      const imgFilename = uniqueFilename(rawFilename);
      putImage(imgFilename, buf, imgFile.mediaType);
      manifestImageMap[normalizedPath] = imgFilename;
      downloadedImageCount++;
    }

    // --- Phase 2: fetch chapters (adaptive pool), then process in order ---
    const chapters = [];

    // A hard SESSION_EXPIRED/abort must fail the whole run; an ordinary fetch
    // failure just yields null for that chapter (→ placeholder). We surface the
    // former by rethrowing it from the worker (the pool marks it fatal).
    const chapterTexts = await this._adaptivePool(chapterFiles, async (chapterFile, idx, onRateLimit) => {
      try {
        const res = await Fetcher._fetchWithRetry(chapterFile.url, { signal, onRateLimit });
        return await res.text();
      } catch (err) {
        if (err.name === 'AbortError' || err.message === 'SESSION_EXPIRED') throw err;
        console.warn(`Chapter fetch failed: ${chapterFile.path}`, err);
        return null;
      }
    }, {
      startC: 4, minC: 1, maxC: 8, signal,
      onProgress: (d) => onProgress({ chapter: d, totalChapters, images: downloadedImageCount, totalImages: imageFiles.length }),
    });

    for (let idx = 0; idx < chapterFiles.length; idx++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      {
        const chapterOriginalPath = chapterFiles[idx].path;
        const chapterNum = idx + 1;
        const filename = `chapter_${String(chapterNum).padStart(2, '0')}.xhtml`;

        let xhtml = chapterTexts[idx];
        if (xhtml == null) {
          const placeholder = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>Chapter ${chapterNum}</title></head>
<body><p><em>Chapter ${chapterNum} could not be downloaded.</em></p></body>
</html>`;
          zip.file(`OEBPS/Text/${filename}`, placeholder);
          chapters.push({ filename, title: `Chapter ${chapterNum} (unavailable)` });
          if (collectPdf) chapterHtmls.push({ title: `Chapter ${chapterNum} (unavailable)`, xhtml: placeholder });
          continue;
        }

        const doc = Fetcher.parseXhtml(xhtml);
        const h1 = doc.querySelector('h1');
        const titleEl = doc.querySelector('title');
        const chapterTitle = h1 ? h1.textContent.trim()
          : titleEl ? titleEl.textContent.trim()
          : `Chapter ${chapterNum}`;

        const imgUrls = Fetcher.extractImageUrls(xhtml);
        const chapterImageMap = {};

        for (const imgSrc of imgUrls) {
          if (imageMap[imgSrc]) {
            chapterImageMap[imgSrc] = imageMap[imgSrc];
            continue;
          }

          const { resolved, isAbsolute } = PathUtils.resolveImagePath(imgSrc, chapterOriginalPath);
          const normalizedResolved = PathUtils.normalizePath(resolved);

          // Strategy 1: pre-downloaded manifest image by resolved path
          if (manifestImageMap[normalizedResolved]) {
            imageMap[imgSrc] = manifestImageMap[normalizedResolved];
            chapterImageMap[imgSrc] = imageMap[imgSrc];
            continue;
          }

          // Strategy 2: match by filename
          const srcFilename = imgSrc.split('/').pop().split('?')[0];
          const manifestMatch = Object.entries(manifestImageMap).find(
            ([path]) => path.split('/').pop() === srcFilename
          );
          if (manifestMatch) {
            imageMap[imgSrc] = manifestMatch[1];
            chapterImageMap[imgSrc] = imageMap[imgSrc];
            continue;
          }

          // Strategy 3: fetch via O'Reilly API (relative image refs)
          const cleanFilename = Fetcher.stripQueryAndHash(srcFilename);
          const imgFilename = uniqueFilename(`ch${String(chapterNum).padStart(2, '0')}_${cleanFilename}`);
          if (!isAbsolute) {
            const cleanResolved = Fetcher.stripQueryAndHash(normalizedResolved);
            const apiUrl = `${apiBase}/api/v2/epubs/urn:orm:book:${isbn}/files/${cleanResolved}`;
            try {
              const imgRes = await Fetcher._fetchWithRetry(apiUrl, { signal });
              putImage(imgFilename, await imgRes.arrayBuffer());
              imageMap[imgSrc] = imgFilename;
              chapterImageMap[imgSrc] = imgFilename;
              downloadedImageCount++;
              continue;
            } catch (e) {
              console.warn(`API image fetch failed: ${apiUrl}`, e);
            }
          }

          // Strategy 4: absolute CDN URL via background CORS proxy
          if (isAbsolute) {
            try {
              const buffer = await this._fetchImageViaBackground(resolved);
              putImage(imgFilename, buffer);
              imageMap[imgSrc] = imgFilename;
              chapterImageMap[imgSrc] = imgFilename;
              downloadedImageCount++;
            } catch (e) {
              console.warn(`Image fetch failed (all strategies): ${imgSrc}`, e);
            }
          } else {
            console.warn(`Image not found in manifest or API: ${imgSrc}`);
          }
        }

        xhtml = EinkOptimizer.processChapter(xhtml, chapterImageMap);
        zip.file(`OEBPS/Text/${filename}`, xhtml);
        chapters.push({ filename, title: chapterTitle });
        if (collectPdf) chapterHtmls.push({ title: chapterTitle, xhtml });
      }
    }

    const meta = await this.fetchBookMetadata(apiBase, isbn, fallbackTitle);
    const bookTitle = meta.title || fallbackTitle || `book-${isbn}`;
    const authors = meta.authors || ['Unknown Author'];

    const metadata = {
      title: bookTitle, authors, isbn,
      language: 'en',
      modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };

    const allCssFiles = [...cssFilenames, 'eink-override.css'];
    const allImageFiles = [...new Set([
      ...Object.values(manifestImageMap),
      ...Object.values(cssImageMap),
      ...Object.values(imageMap),
    ])];

    const coverImage = EpubBuilder.findCoverImage(allImageFiles);

    // PDF path: assemble one inlined HTML document and hand it back for printing.
    if (collectPdf) {
      const html = this._assemblePrintHtml({
        bookTitle, authors, chapterHtmls, cssTexts, einkCss, pdfImages, coverImage,
      });
      return { html, title: bookTitle };
    }

    if (coverImage) {
      zip.file('OEBPS/Text/cover.xhtml', EpubBuilder.generateCoverXhtml(bookTitle, coverImage));
      chapters.unshift({ filename: 'cover.xhtml', title: 'Cover' });
    }

    zip.file('OEBPS/content.opf', EpubBuilder.generateOpf(metadata, chapters, allImageFiles, allCssFiles, coverImage));
    zip.file('OEBPS/toc.xhtml', EpubBuilder.generateTocXhtml(metadata.title, chapters));
    zip.file('OEBPS/toc.ncx', EpubBuilder.generateTocNcx(isbn, metadata.title, chapters));

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    const sanitizedTitle = bookTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || `book-${isbn}`;
    return { blob, filename: `${sanitizedTitle}.epub`, title: bookTitle };
  },

  // Base64 data: URL from an ArrayBuffer (chunked to avoid arg-count limits).
  _toDataUrl(buffer, mime) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
  },

  // Escape a string for safe use in an HTML text/attribute context.
  _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // Build a single self-contained HTML document for printing to PDF. Images are
  // inlined as data: URLs; the publisher CSS (+ our light overrides) is inlined;
  // each chapter is a page-breaking section. No scripts (extension-page CSP).
  _assemblePrintHtml({ bookTitle, authors, chapterHtmls, cssTexts, einkCss, pdfImages, coverImage }) {
    // Replace every ../Images/<name> reference with its data: URL.
    const inlineImages = (text) => text.replace(
      /\.\.\/Images\/([A-Za-z0-9._%\-]+)/g,
      (m, name) => {
        const img = pdfImages[name];
        return img ? this._toDataUrl(img.buffer, img.mime) : m;
      }
    );

    let combinedCss = inlineImages([...cssTexts, einkCss].join('\n'));

    const printCss = `
/* print/pdf assembly */
@page { margin: 1.4cm; }
html, body { margin: 0; padding: 0; }
.chapter { break-after: page; page-break-after: always; }
.chapter:last-child { break-after: auto; page-break-after: auto; }
.chapter.cover { text-align: center; }
.chapter.cover img { max-height: 95vh; }
img, svg { max-width: 100%; height: auto; }
`;

    const sections = [];
    if (coverImage && pdfImages[coverImage]) {
      const src = this._toDataUrl(pdfImages[coverImage].buffer, pdfImages[coverImage].mime);
      sections.push(`<section class="chapter cover"><img src="${src}" alt=""/></section>`);
    }
    for (const ch of chapterHtmls) {
      const doc = Fetcher.parseXhtml(ch.xhtml);
      const bodyInner = doc && doc.body ? doc.body.innerHTML : '';
      sections.push(`<section class="chapter">${inlineImages(bodyInner)}</section>`);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${this._escapeHtml(bookTitle)}</title>
<meta name="author" content="${this._escapeHtml((authors || []).join(', '))}"/>
<style>${combinedCss}${printCss}</style>
</head>
<body>
${sections.join('\n')}
</body>
</html>`;
  },
};
