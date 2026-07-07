// Regression tests for Downloader.classifyFiles, pinned to the REAL manifest
// shape observed from learning.oreilly.com (…/files/?limit=200):
//   { count, next, previous, results: [ { full_path, filename, media_type,
//     kind, file_size, url, ... } ] }
// kind ∈ {chapter, image, stylesheet, other_asset}; media_type is a MIME type.
describe('Downloader.classifyFiles (real O\'Reilly manifest shape)', function() {
  const ISBN = '9781784398781';
  const manifest = [
    { full_path: 'cover.html', filename: 'cover.html', media_type: 'text/html', kind: 'chapter' },
    { full_path: 'ch01.html', filename: 'ch01.html', media_type: 'text/html', kind: 'chapter' },
    { full_path: 'graphics/8781OS_01_02.jpg', filename: '8781OS_01_02.jpg', media_type: 'image/jpeg', kind: 'image' },
    { full_path: 'cover/cover.jpg', filename: 'cover.jpg', media_type: 'image/jpeg', kind: 'image' },
    { full_path: 'epub.css', filename: 'epub.css', media_type: 'text/css', kind: 'stylesheet' },
    // other_asset entries (the OPF package + NCX) must NOT land in any bucket
    { full_path: 'content.opf', filename: 'content.opf', media_type: 'application/oebps-package+xml', kind: 'other_asset' },
    { full_path: 'toc.ncx', filename: 'toc.ncx', media_type: 'application/x-dtbncx+xml', kind: 'other_asset' },
  ];

  it('classifies chapters / images / css by the real fields', function() {
    const { chapterFiles, cssFiles, imageFiles } = Downloader.classifyFiles('', ISBN, manifest);
    assertEqual(chapterFiles.length, 2, 'two html chapters');
    assertEqual(imageFiles.length, 2, 'two jpeg images');
    assertEqual(cssFiles.length, 1, 'one stylesheet');
  });

  it('excludes other_asset entries (opf/ncx) from every bucket', function() {
    const { chapterFiles, cssFiles, imageFiles } = Downloader.classifyFiles('', ISBN, manifest);
    const all = [...chapterFiles, ...cssFiles, ...imageFiles].map(f => f.path);
    assert(!all.includes('content.opf'), 'opf must be skipped');
    assert(!all.includes('toc.ncx'), 'ncx must be skipped');
  });

  it('builds same-origin content URLs when apiBase is empty', function() {
    const { chapterFiles } = Downloader.classifyFiles('', ISBN, manifest);
    assertEqual(chapterFiles[0].url, `/api/v2/epubs/urn:orm:book:${ISBN}/files/cover.html`);
  });

  it('builds absolute content URLs when apiBase is set (manager context)', function() {
    const base = 'https://learning.oreilly.com';
    const { imageFiles } = Downloader.classifyFiles(base, ISBN, manifest);
    assertEqual(imageFiles[0].url, `${base}/api/v2/epubs/urn:orm:book:${ISBN}/files/graphics/8781OS_01_02.jpg`);
  });

  it('also accepts media_type-only chapters (no kind field)', function() {
    const { chapterFiles } = Downloader.classifyFiles('', ISBN, [
      { full_path: 'x.xhtml', media_type: 'application/xhtml+xml' },
    ]);
    assertEqual(chapterFiles.length, 1);
  });
});

describe('Downloader._adaptivePool', function() {
  const tick = () => new Promise(r => setTimeout(r, 1));

  it('returns results index-aligned with the input', async function() {
    const items = [10, 20, 30, 40, 50];
    const out = await Downloader._adaptivePool(items, async (v) => { await tick(); return v * 2; }, { startC: 2 });
    assertEqual(out.join(','), '20,40,60,80,100');
  });

  it('resolves to [] for empty input', async function() {
    const out = await Downloader._adaptivePool([], async () => 1, {});
    assertEqual(out.length, 0);
  });

  it('never exceeds maxC in flight and ramps up from startC', async function() {
    let inFlight = 0, peak = 0;
    await Downloader._adaptivePool(Array.from({ length: 40 }, (_, i) => i), async () => {
      inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--;
    }, { startC: 2, minC: 1, maxC: 6 });
    assert(peak <= 6, `peak ${peak} must not exceed maxC=6`);
    assert(peak > 2, `peak ${peak} should ramp above startC=2`);
  });

  it('halves concurrency when a worker reports a rate limit but still completes', async function() {
    let inFlight = 0, peak = 0, hits = 0;
    const out = await Downloader._adaptivePool(Array.from({ length: 40 }, (_, i) => i), async (v, idx, onRateLimit) => {
      inFlight++; peak = Math.max(peak, inFlight);
      const over = inFlight > 4;
      await tick();
      if (over) { hits++; onRateLimit(); }
      inFlight--;
      return v;
    }, { startC: 8, minC: 1, maxC: 8 });
    assertEqual(out.length, 40);
    assert(out.every((v, i) => v === i), 'all items completed in order');
    assert(hits > 0, 'rate-limit path should have been exercised');
  });

  it('turns an ordinary worker error into null (non-fatal)', async function() {
    const out = await Downloader._adaptivePool([1, 2, 3], async (v) => {
      if (v === 2) throw new Error('boom');
      return v;
    }, { startC: 1 });
    assertEqual(out[0], 1);
    assertEqual(out[1], null);
    assertEqual(out[2], 3);
  });

  it('rejects the whole pool on SESSION_EXPIRED', async function() {
    let msg = null;
    try {
      await Downloader._adaptivePool([1, 2], async () => { throw new Error('SESSION_EXPIRED'); }, { startC: 1 });
    } catch (e) { msg = e.message; }
    assertEqual(msg, 'SESSION_EXPIRED');
  });
});
