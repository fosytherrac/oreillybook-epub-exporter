describe('Catalog.buildSearchUrl', function() {
  it('builds a book search URL with defaults', function() {
    const url = Catalog.buildSearchUrl({ query: 'Programming' });
    assertContains(url, '/api/v2/search/?');
    assertContains(url, 'query=Programming');
    assertContains(url, 'formats=book');
    assertContains(url, 'page=0');
  });
  it('defaults an empty query to * (browse everything)', function() {
    const url = Catalog.buildSearchUrl({});
    assertContains(url, 'query=*'); // URLSearchParams leaves '*' unescaped
  });
  it('includes a topics filter only when provided', function() {
    assertContains(Catalog.buildSearchUrl({ query: 'x', topic: 'Security' }), 'topics=Security');
    assert(!Catalog.buildSearchUrl({ query: 'x' }).includes('topics='), 'no empty topics param');
  });
  it('paginates via the page parameter', function() {
    assertContains(Catalog.buildSearchUrl({ query: 'x', page: 3, limit: 50 }), 'page=3');
    assertContains(Catalog.buildSearchUrl({ query: 'x', page: 3, limit: 50 }), 'limit=50');
  });
});

describe('Catalog.extractIsbn', function() {
  it('reads a direct 13-digit isbn field', function() {
    assertEqual(Catalog.extractIsbn({ isbn: '9781098115302' }), '9781098115302');
  });
  it('falls back to archive_id / identifier', function() {
    assertEqual(Catalog.extractIsbn({ archive_id: '9781491954621' }), '9781491954621');
    assertEqual(Catalog.extractIsbn({ identifier: 'urn:orm:book:9780596007126' }), '9780596007126');
  });
  it('extracts the isbn embedded in a web_url', function() {
    assertEqual(
      Catalog.extractIsbn({ web_url: 'https://learning.oreilly.com/library/view/-/9781492092391/' }),
      '9781492092391'
    );
  });
  it('returns null when no isbn is present', function() {
    assertEqual(Catalog.extractIsbn({ title: 'No ID here' }), null);
    assertEqual(Catalog.extractIsbn(null), null);
  });
});

describe('Catalog.normalizeBook', function() {
  it('normalizes a typical record', function() {
    const b = Catalog.normalizeBook({
      title: '  Learning Python  ',
      authors: ['Mark Lutz'],
      isbn: '9781449355739',
      cover_url: 'https://cdn/cover.jpg',
      publishers: ['O\'Reilly Media'],
    });
    assertEqual(b.title, 'Learning Python');
    assertEqual(b.isbn, '9781449355739');
    assertEqual(b.authors[0], 'Mark Lutz');
    assertEqual(b.coverUrl, 'https://cdn/cover.jpg');
    assertEqual(b.publisher, 'O\'Reilly Media');
    assertContains(b.webUrl, '9781449355739');
  });
  it('handles authors given as {name} objects', function() {
    const b = Catalog.normalizeBook({ title: 'X', isbn: '9781000000000', authors: [{ name: 'Jane Doe' }] });
    assertEqual(b.authors[0], 'Jane Doe');
  });
  it('absolutizes a site-relative web_url', function() {
    const b = Catalog.normalizeBook({
      title: 'Ansible: Up and Running',
      isbn: '9781098109141',
      web_url: '/library/view/ansible-up-and/9781098109141/',
    });
    assertEqual(b.webUrl, 'https://learning.oreilly.com/library/view/ansible-up-and/9781098109141/');
  });
  it('derives a web URL from the isbn when none is given', function() {
    const b = Catalog.normalizeBook({ title: 'X', isbn: '9781234567897' });
    assertEqual(b.webUrl, 'https://learning.oreilly.com/library/view/-/9781234567897/');
  });
  it('keeps books without an isbn but leaves it null', function() {
    const b = Catalog.normalizeBook({ title: 'Mystery' });
    assertEqual(b.isbn, null);
    assertEqual(b.webUrl, null);
  });
});

describe('Catalog.parseSearchResponse', function() {
  it('parses a results array and total', function() {
    const parsed = Catalog.parseSearchResponse({
      total: 42,
      results: [
        { title: 'A', isbn: '9781111111111' },
        { title: 'B', isbn: '9782222222222' },
      ],
    });
    assertEqual(parsed.books.length, 2);
    assertEqual(parsed.total, 42);
    assertEqual(parsed.books[0].title, 'A');
  });
  it('falls back to count, then to the array length', function() {
    assertEqual(Catalog.parseSearchResponse({ count: 7, results: [] }).total, 7);
    assertEqual(Catalog.parseSearchResponse({ results: [{ title: 'X', isbn: '9781111111111' }] }).total, 1);
  });
  it('tolerates a bare array or garbage input', function() {
    assertEqual(Catalog.parseSearchResponse([{ title: 'X', isbn: '9781111111111' }]).books.length, 1);
    assertEqual(Catalog.parseSearchResponse(null).books.length, 0);
    assertEqual(Catalog.parseSearchResponse('nope').books.length, 0);
  });
});

describe('Catalog.nextUrlFromResponse', function() {
  it('reduces an absolute next URL to a same-origin path', function() {
    const next = 'https://learning.oreilly.com/api/v2/search/?query=x&page=1';
    assertEqual(Catalog.nextUrlFromResponse({ next }), '/api/v2/search/?query=x&page=1');
  });
  it('passes through a relative next path', function() {
    assertEqual(Catalog.nextUrlFromResponse({ next: '/api/v2/search/?page=2' }), '/api/v2/search/?page=2');
  });
  it('returns null when there is no next link', function() {
    assertEqual(Catalog.nextUrlFromResponse({}), null);
  });
});
