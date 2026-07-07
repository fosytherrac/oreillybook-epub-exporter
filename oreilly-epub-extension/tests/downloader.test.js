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
