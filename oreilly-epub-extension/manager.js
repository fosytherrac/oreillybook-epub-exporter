(function() {
  'use strict';

  // Full-page catalog browser. Reuses the shared CatalogUI wiring; the roomier
  // grid layout is entirely in manager.css (same markup as the popup).
  CatalogUI.init({
    topic: document.getElementById('browse-topic'),
    query: document.getElementById('browse-query'),
    btn: document.getElementById('btn-browse'),
    status: document.getElementById('browse-status'),
    results: document.getElementById('browse-results'),
    export: document.getElementById('btn-export'),
  }, { maxBooks: 500 });
})();
