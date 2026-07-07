// Catalog querying for the O'Reilly search API.
//
// Pure helpers (URL building + response parsing) plus a curated list of
// common categories. No side effects — the actual fetching/pagination lives
// in background.js, which imports this module via importScripts().
//
// Loaded as a global object (same pattern as Fetcher / EpubBuilder). In the
// service worker it is pulled in with importScripts('lib/catalog.js'); in the
// popup and the test runner it is loaded with a plain <script> tag.
//
// API notes / assumptions (the search API is undocumented and its response
// shape varies between deployments, so parsing is deliberately defensive):
//   GET /api/v2/search/?query=<term>&formats=book&limit=<n>&page=<0-based>
//   -> { results: [ { title, authors, isbn|archive_id, web_url, cover_url, ... } ],
//        total|count, next }
const Catalog = {
  // Common O'Reilly categories, surfaced as quick picks in the popup. These
  // are used as plain search queries (query=<category>), which the search API
  // reliably supports — no dependency on an exact topic-slug taxonomy.
  TOPICS: [
    'Programming',
    'Software Development',
    'Software Architecture',
    'Python',
    'JavaScript',
    'Java',
    'Go',
    'Rust',
    'C++',
    'Web Development',
    'Data Science',
    'Machine Learning',
    'Artificial Intelligence',
    'Databases',
    'Security',
    'Cloud Computing',
    'DevOps',
    'Kubernetes',
    'Networking',
    'System Administration',
    'Design',
    'Business',
  ],

  // Build a search-API URL for one page of catalog results.
  //   query  - free-text search term (a category name works well); '*' = everything
  //   topic  - optional topics= filter (best-effort; off by default)
  //   page   - 0-based page index
  //   limit  - results per page
  buildSearchUrl({ query = '', topic = '', page = 0, limit = 100 } = {}) {
    const params = new URLSearchParams();
    params.set('query', (query && query.trim()) || '*');
    params.set('formats', 'book');
    if (topic) params.set('topics', topic);
    params.set('limit', String(limit));
    params.set('page', String(page));
    return `/api/v2/search/?${params.toString()}`;
  },

  // Pull a 13-digit ISBN out of a book record, trying the many field shapes
  // the API has been observed to use.
  extractIsbn(book) {
    if (!book) return null;
    const candidates = [book.isbn, book.archive_id, book.identifier, book.id];
    for (const c of candidates) {
      if (c == null) continue;
      const m = String(c).match(/(\d{13})/);
      if (m) return m[1];
    }
    // Fall back to a URL that embeds the ISBN, e.g. /library/view/-/9781098115302/
    const url = book.web_url || book.url || book.public_url || '';
    const m = String(url).match(/(\d{13})/);
    return m ? m[1] : null;
  },

  // Normalize author entries which may be plain strings or {name} objects.
  _authors(book) {
    const raw = book.authors || book.author || [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .map((a) => (typeof a === 'string' ? a : a && (a.name || a.full_name)) || '')
      .map((s) => s.trim())
      .filter(Boolean);
  },

  // Convert one raw API record into the shape the UI consumes.
  normalizeBook(book) {
    const isbn = this.extractIsbn(book);
    const webUrl =
      book.web_url ||
      book.url ||
      (isbn ? `https://learning.oreilly.com/library/view/-/${isbn}/` : null);
    const publishers = book.publishers || book.publisher;
    return {
      isbn,
      title: (book.title || book.name || 'Untitled').trim(),
      authors: this._authors(book),
      publisher: Array.isArray(publishers) ? publishers.join(', ') : publishers || '',
      issued: book.issued || book.publication_date || book.date || '',
      coverUrl: book.cover_url || book.custom_cover_url || book.virtual_pages_cover_url || '',
      webUrl,
    };
  },

  // Parse one page of results into { books, total }. Never throws on odd input.
  parseSearchResponse(json) {
    if (!json || typeof json !== 'object') return { books: [], total: 0 };
    const results = json.results || json.data || (Array.isArray(json) ? json : []);
    const books = (Array.isArray(results) ? results : []).map((b) => this.normalizeBook(b));
    const total =
      typeof json.total === 'number'
        ? json.total
        : typeof json.count === 'number'
        ? json.count
        : books.length;
    return { books, total };
  },

  // Resolve the API's "next page" link to a same-origin relative path, or null.
  nextUrlFromResponse(json) {
    const next = json && json.next;
    if (!next) return null;
    try {
      const u = new URL(next, 'https://learning.oreilly.com');
      return u.pathname + u.search;
    } catch (e) {
      return typeof next === 'string' && next.startsWith('/') ? next : null;
    }
  },
};

// Export for CommonJS-style consumers if present (harmless in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Catalog;
}
