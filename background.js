// background.js v6 — Maximum Force Extractor
// All timing bugs fixed. prepare() properly awaited for EVERY page (seed + crawled).

importScripts('jszip.min.js');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'dump') {
    runDump(msg.data, msg.prepareStats, msg.origin, msg.options)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ── Fetch with timeout ───────────────────────────────────────────────────────
async function fetchWithTimeout(url, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'force-cache', signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (e) { clearTimeout(timer); throw e; }
}

// ── URL → zip path ───────────────────────────────────────────────────────────
function urlToZipPath(url, origin) {
  try {
    const u = new URL(url);
    if (u.origin === origin) {
      let path = u.pathname.replace(/^\//, '');
      if (!path) path = 'index.html';
      return path;
    } else {
      const host = u.hostname.replace(/\./g, '_');
      const p = u.pathname.replace(/^\//, '').split('?')[0];
      return ('assets/external/' + host + '/' + (p || 'asset')).substring(0, 220);
    }
  } catch (_) {
    return 'assets/other/asset_' + Math.random().toString(36).slice(2, 8);
  }
}

// ── URL → page HTML zip path ─────────────────────────────────────────────────
function urlToHtmlZipPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname;
    if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
    if (p === '/') return 'index.html';
    if (!p.split('/').pop().includes('.')) return p.replace(/^\//, '') + '/index.html';
    return p.replace(/^\//, '');
  } catch (_) {
    return 'page_' + Math.random().toString(36).slice(2, 6) + '.html';
  }
}

// ── Relative path ────────────────────────────────────────────────────────────
function computeRelative(fromDir, toPath) {
  const from = fromDir ? fromDir.split('/') : [];
  const to = toPath.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const ups = from.slice(shared).map(() => '..');
  const down = to.slice(shared);
  return [...ups, ...down].join('/') || toPath;
}

// ── Progress notifier ────────────────────────────────────────────────────────
async function progress(msg) {
  await chrome.storage.local.set({ dumper_progress: msg });
}

// ── CSS processor: handles @import + url() recursively ──────────────────────
async function fetchCssUrls(cssText, cssUrl, origin, zip, assetMap, stats) {
  // @import rules
  const importRegex = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi;
  const imports = [];
  let m;
  while ((m = importRegex.exec(cssText)) !== null) {
    try {
      const abs = new URL(m[1], cssUrl).href;
      if (!assetMap[abs]) imports.push(abs);
    } catch (_) {}
  }
  for (const u of [...new Set(imports)]) await fetchAndSave(u, origin, zip, assetMap, stats);

  // url() references
  const urlRegex = /url\(["']?([^"')]+)["']?\)/g;
  const toFetch = [];
  while ((m = urlRegex.exec(cssText)) !== null) {
    const raw = m[1];
    if (raw.startsWith('data:')) continue;
    try {
      const abs = new URL(raw, cssUrl).href;
      if (!assetMap[abs]) toFetch.push(abs);
    } catch (_) {}
  }
  await Promise.all([...new Set(toFetch)].map(u => fetchAndSave(u, origin, zip, assetMap, stats)));

  // Rewrite @imports
  let out = cssText.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?([^;]*);/gi, (full, raw) => {
    try {
      const abs = new URL(raw, cssUrl).href;
      const zp = assetMap[abs];
      if (!zp || zp === '__pending__') return full;
      const cssDir = urlToZipPath(cssUrl, origin).split('/').slice(0, -1).join('/');
      return `@import url("${computeRelative(cssDir, zp)}");`;
    } catch (_) { return full; }
  });

  // Rewrite url()
  return out.replace(/url\(["']?([^"')]+)["']?\)/g, (full, raw) => {
    if (raw.startsWith('data:')) return full;
    try {
      const abs = new URL(raw, cssUrl).href;
      const zp = assetMap[abs];
      if (!zp || zp === '__pending__') return full;
      const cssDir = urlToZipPath(cssUrl, origin).split('/').slice(0, -1).join('/');
      return `url("${computeRelative(cssDir, zp)}")`;
    } catch (_) { return full; }
  });
}

// ── Fetch one asset ──────────────────────────────────────────────────────────
async function fetchAndSave(url, origin, zip, assetMap, stats, timeoutMs = 15000) {
  if (!url) return null;
  if (assetMap[url] && assetMap[url] !== '__pending__') return assetMap[url];
  if (assetMap[url] === '__pending__') return null;
  assetMap[url] = '__pending__';

  try {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) { stats.fail++; delete assetMap[url]; return null; }

    const contentType = res.headers.get('content-type') || '';
    const buf = await (await res.blob()).arrayBuffer();
    const zipPath = urlToZipPath(url, origin);

    if (contentType.includes('text/css') || zipPath.endsWith('.css')) {
      const text = new TextDecoder().decode(buf);
      const fixed = await fetchCssUrls(text, url, origin, zip, assetMap, stats);
      zip.file(zipPath, fixed);
    } else {
      zip.file(zipPath, buf);
    }

    assetMap[url] = zipPath;

    // Register root-relative alias
    try {
      const u = new URL(url);
      if (u.origin === origin && u.pathname !== '/') {
        assetMap[u.pathname] = zipPath;
      }
    } catch (_) {}

    stats.ok++;
    return zipPath;
  } catch (_) {
    stats.fail++;
    delete assetMap[url];
    return null;
  }
}

// ── ANIMATION UNFREEZE CSS ───────────────────────────────────────────────────
const UNFREEZE_CSS = `
/* Site Dumper v6 — Animation Unfreeze */
[data-scroll-reveal],[data-aos],[data-sal],[data-animate],[data-revealed],
[data-animation],[data-motion] {
  opacity:1!important;transform:none!important;filter:none!important;visibility:visible!important;
}
.alive-char,.interactive-char,.paint-char,.contact-interactive-char,.char,.word,.line {
  opacity:1!important;transform:none!important;filter:none!important;color:inherit!important;
}
[style*="opacity: 0"]:not([aria-hidden="true"]):not(script):not(style):not(noscript) { opacity:1!important; }
[style*="opacity:0"]:not([aria-hidden="true"]):not(script):not(style):not(noscript)  { opacity:1!important; }
[style*="will-change: transform"],[style*="will-change:transform"] { transform:none!important; }
[style*="transform: translateY"],[style*="transform: translateX"] { transform:none!important; }
html.lenis { scroll-behavior:auto!important; }
.branched-menu__reach { stroke-dashoffset:0!important; }
[data-framer-appear-id] { opacity:1!important; transform:none!important; }
`;

// ── HTML REWRITER ────────────────────────────────────────────────────────────
function rewriteHtml(html, assetMap, pageUrl, origin, framework) {
  let out = html;
  const pageZipPath = urlToHtmlZipPath(pageUrl);
  const pageDir = pageZipPath.split('/').slice(0, -1).join('/');

  function relTo(zp) { return computeRelative(pageDir, zp); }

  // 1. /_next/image optimizer URLs
  out = out.replace(/\/_next\/image\?url=([^"'\s>]+)/g, (full, rest) => {
    const cleanRest = rest.replace(/&amp;/g, '&');
    const urlParam = cleanRest.split('&')[0];
    try {
      const decoded = decodeURIComponent(urlParam);
      const realUrl = decoded.startsWith('http') ? decoded : origin + decoded;
      const zp = assetMap[realUrl] || assetMap[decoded];
      if (zp) return relTo(zp);
    } catch (_) {}
    return full;
  });

  // 2. All assets — dual lookup sorted longest key first
  const entries = Object.entries(assetMap)
    .filter(([k, v]) => v && v !== '__pending__' && !k.startsWith('/_next/image'))
    .sort((a, b) => b[0].length - a[0].length);

  for (const [key, zp] of entries) {
    const rel = relTo(zp);
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), rel);
  }

  // 3. Inject unfreeze CSS
  if (out.includes('</head>')) {
    out = out.replace('</head>', `<style id="__dumper_unfreeze__">${UNFREEZE_CSS}</style>\n</head>`);
  }

  // 4. Framework shims
  if (framework === 'nextjs') {
    out = out.replace(/<script[^>]*>self\.__next_f\.push[\s\S]*?<\/script>/g, '');
    out = out.replace('</body>',
      `<script>if(typeof window!=='undefined'){window.__NEXT_ROUTER_BASEPATH='';window.__next_f=window.__next_f||[];window.__next_f.push=function(){};}` +
      `</script>\n</body>`);
  } else if (framework === 'nuxt') {
    out = out.replace('</body>',
      `<script>window.__NUXT__=window.__NUXT__||{data:[],state:{},_errors:{},serverRendered:true};</script>\n</body>`);
  } else if (framework === 'sveltekit') {
    out = out.replace('</body>',
      `<script>window.__sveltekit_dev=false;</script>\n</body>`);
  }

  return out;
}

// ── Crawl a page via background tab — PROPERLY awaits prepare() ─────────────
async function fetchPageViaTab(url) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;

    // Wait for tab to fully load
    await new Promise((resolve, reject) => {
      const hardTimeout = setTimeout(() => reject(new Error('Tab load timeout')), 120000);
      function onUpdated(id, info) {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(hardTimeout);
        resolve();
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      // Check if already complete
      chrome.tabs.get(tabId, t => {
        if (t?.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(hardTimeout);
          resolve();
        }
      });
    });

    // Small buffer for JS to hydrate
    await new Promise(r => setTimeout(r, 1000));

    // CRITICAL: await prepare() — this blocks until scroll+interact+settle done
    const prepResult = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'prepare' }, res => {
        resolve(res || { ok: false });
      });
    });

    // Now collect — DOM is fully settled
    const data = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'collect' }, res => resolve(res || null));
    });

    if (data && prepResult) {
      data._prepStats = prepResult;
    }

    return data;
  } catch (_) {
    return null;
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── MAIN runDump ─────────────────────────────────────────────────────────────
async function runDump(seedAssets, seedPrepStats, origin, options = {}) {
  const zip = new JSZip();
  const stats = {
    ok: 0, fail: 0, pages: 0, missed: 0,
    interactive_clicks: 0, new_assets_from_clicks: 0
  };
  const maxPages = options.maxPages || 20;
  const assetMap = {};
  const framework = seedAssets.framework || 'static';

  // Track prepare stats
  if (seedPrepStats) {
    stats.interactive_clicks += seedPrepStats.clicks || 0;
    stats.new_assets_from_clicks += seedPrepStats.new_assets_from_clicks || 0;
  }

  // ── PHASE 1: Multi-page crawl ─────────────────────────────────────────────
  const visitedPages = new Map();
  const queue = [origin];
  const queued = new Set([origin]);

  visitedPages.set(origin, seedAssets);
  stats.pages++;

  for (const link of (seedAssets.internal_links || [])) {
    try {
      const clean = new URL(link); clean.hash = '';
      const cs = clean.href;
      if (!queued.has(cs)) { queued.add(cs); queue.push(cs); }
    } catch (_) {}
  }

  for (let qi = 1; qi < queue.length && stats.pages < maxPages; qi++) {
    const pageUrl = queue[qi];
    const pathName = new URL(pageUrl).pathname;
    await progress(`Crawling page ${stats.pages + 1}/${Math.min(queue.length, maxPages)}: ${pathName}`);

    try {
      const pageData = await fetchPageViaTab(pageUrl);
      if (pageData) {
        visitedPages.set(pageUrl, pageData);
        stats.pages++;

        if (pageData._prepStats) {
          stats.interactive_clicks += pageData._prepStats.clicks || 0;
          stats.new_assets_from_clicks += pageData._prepStats.new_assets_from_clicks || 0;
        }

        for (const link of (pageData.internal_links || [])) {
          try {
            const clean = new URL(link); clean.hash = '';
            const cs = clean.href;
            if (!queued.has(cs)) { queued.add(cs); queue.push(cs); }
          } catch (_) {}
        }
      }
    } catch (_) { stats.fail++; }
  }

  // ── PHASE 2: Gather all unique assets across all pages ────────────────────
  const allScripts = new Set();
  const allStyles  = new Set();
  const allImages  = [];
  const allFonts   = new Set();
  const allOther   = new Set();

  for (const [, data] of visitedPages) {
    (data.scripts || []).forEach(u => allScripts.add(u));
    (data.styles  || []).forEach(u => allStyles.add(u));
    (data.fonts   || []).forEach(u => allFonts.add(u));
    (data.other   || []).forEach(u => allOther.add(u));
    (data.images  || []).forEach(img => {
      if (img?.url && !allImages.find(i => i.url === img.url)) allImages.push(img);
    });
  }

  const total = allScripts.size + allStyles.size + allImages.length + allFonts.size + allOther.size;
  await progress(`Fetching ${total} assets from ${stats.pages} page(s)...`);

  // ── PHASE 3: Fetch all assets ─────────────────────────────────────────────
  const BATCH = 10;

  async function batchFetch(urls, timeoutMs = 15000) {
    const arr = [...urls];
    for (let i = 0; i < arr.length; i += BATCH) {
      await Promise.all(
        arr.slice(i, i + BATCH).map(u => fetchAndSave(u, origin, zip, assetMap, stats, timeoutMs))
      );
    }
  }

  await batchFetch(allScripts);
  await batchFetch(allStyles); // CSS fetcher handles url() + @import internally
  await batchFetch(allFonts);
  await batchFetch(allOther);

  // Images — handle /_next/image optimizer
  for (let i = 0; i < allImages.length; i += BATCH) {
    await Promise.all(allImages.slice(i, i + BATCH).map(async img => {
      const zp = await fetchAndSave(img.url, origin, zip, assetMap, stats);
      if (img.originalSrc && img.originalSrc !== img.url && zp) {
        assetMap[img.originalSrc] = zp;
        try {
          const u = new URL(img.originalSrc, origin);
          if (u.pathname) assetMap[u.pathname + (u.search || '')] = zp;
        } catch (_) {}
      }
    }));
  }

  // Extra pass: scan raw HTML for missed static asset paths
  const htmlMissed = new Set();
  for (const [, data] of visitedPages) {
    for (const h of (data.html || [])) {
      const matches = h.content.matchAll(
        /(?:src|href|poster|data-src|data-bg|data-background|content)\s*=\s*["'](\/[^"'#?\s]*\.(?:png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|mp4|webm|pdf|json|webmanifest))["']/gi
      );
      for (const m of matches) {
        const absUrl = origin + m[1];
        if (!assetMap[absUrl] || assetMap[absUrl] === '__pending__') htmlMissed.add(absUrl);
      }
    }
  }
  await batchFetch(htmlMissed);

  // ── PHASE 3.5: Verification pass — find anything still missing ───────────
  await progress('Verifying coverage & retrying missed assets...');

  const referenced = new Set();
  const inlineSkipped = { count: 0 };

  function addRef(raw, base) {
    if (!raw) return;
    const v = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!v || /^(data:|blob:|javascript:|#|mailto:|tel:|about:)/i.test(v)) {
      if (/^data:/i.test(v)) inlineSkipped.count++;
      return;
    }
    try {
      const abs = new URL(v, base).href;
      if (/^https?:/i.test(abs)) referenced.add(abs);
    } catch (_) {}
  }

  function addSrcset(value, base) {
    if (!value || /^\s*data:/i.test(value)) return;
    value.split(/,(?![^(]*\))/).forEach(chunk => {
      const url = chunk.trim().split(/\s+/)[0];
      if (url) addRef(url, base);
    });
  }

  for (const [pageUrl, data] of visitedPages) {
    for (const h of (data.html || [])) {
      const attrPat = /\b(src|href|poster|data-src|data-lazy|data-original|data-bg|data-background|data-background-image|srcset|data-srcset)\s*=\s*(["'])([\s\S]*?)\2/gi;
      let m;
      while ((m = attrPat.exec(h.content)) !== null) {
        const attr = m[1].toLowerCase(), raw = m[3].trim();
        if (attr === 'href') {
          if (!/\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|webmanifest|json|mp4|webm|pdf)(?:[?#]|$)/i.test(raw) &&
              !/^https?:/i.test(raw)) continue;
        }
        if (attr === 'srcset' || attr === 'data-srcset') addSrcset(raw, pageUrl);
        else addRef(raw, pageUrl);
      }
      // CSS url() in inline styles and <style> blocks
      for (const c of h.content.matchAll(/(?:style\s*=\s*["']([^"']*)["']|<style[^>]*>([\s\S]*?)<\/style>)/gi)) {
        const css = c[1] || c[2] || '';
        for (const x of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) addRef(x[1], pageUrl);
      }
    }
  }

  // Also scan already-downloaded CSS files for more references
  const scannedCss = new Set();
  for (const [key, zp] of Object.entries(assetMap)) {
    if (!zp || zp === '__pending__' || !String(zp).endsWith('.css') || scannedCss.has(zp)) continue;
    scannedCss.add(zp);
    const f = zip.file(zp); if (!f) continue;
    const css = await f.async('string');
    for (const x of css.matchAll(/(?:url\(\s*["']?|@import\s+(?:url\(\s*)?["']?)([^"')\s;]+)/gi)) {
      addRef(x[1], key.startsWith('http') ? key : origin);
    }
  }

  // Add all known collected URLs to referenced
  for (const s of [allScripts, allStyles, allFonts, allOther]) s.forEach(u => addRef(u, origin));
  allImages.forEach(img => addRef(img.url, origin));

  const isSaved = url => {
    try {
      const u = new URL(url);
      const v1 = assetMap[url];
      const v2 = assetMap[u.pathname];
      return (v1 && v1 !== '__pending__') || (v2 && v2 !== '__pending__');
    } catch (_) { return false; }
  };

  // Parse PWA manifests for icon URLs
  const pwaChecks = [];
  for (const u of allOther) {
    if (!/manifest(?:\.webmanifest|\.json)?(?:[?#]|$)/i.test(u)) continue;
    try {
      const f = zip.file(assetMap[u]);
      if (!f) continue;
      const manifest = JSON.parse(await f.async('string'));
      const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
      const iconUrls = [];
      for (const icon of icons) {
        try { const iu = new URL(icon.src, u).href; referenced.add(iu); iconUrls.push(iu); } catch (_) {}
      }
      pwaChecks.push({ manifest: u, icon_count: icons.length, icons: iconUrls });
    } catch (_) {}
  }

  // Retry missed with longer timeout
  const missedUrls = [...referenced].filter(u => !isSaved(u));
  await progress(`Retrying ${missedUrls.length} missed assets...`);
  for (let i = 0; i < missedUrls.length; i += BATCH) {
    await Promise.all(
      missedUrls.slice(i, i + BATCH).map(u => fetchAndSave(u, origin, zip, assetMap, stats, 30000))
    );
  }

  const stillMissed = [...referenced].filter(u => !isSaved(u));
  stats.missed = stillMissed.length;

  // Empty file check
  const emptyFiles = [];
  for (const [name] of Object.entries(zip.files)) {
    if (name.startsWith('_dump_meta/') || zip.files[name].dir) continue;
    const f = zip.file(name);
    if (f?._data?.uncompressedSize === 0) emptyFiles.push(name);
  }

  // ── PHASE 4: Rewrite HTML and package ────────────────────────────────────
  await progress('Rewriting HTML & packaging ZIP...');

  for (const [pageUrl, data] of visitedPages) {
    const pf = data.framework || framework;
    for (const h of (data.html || [])) {
      const rewritten = rewriteHtml(h.content, assetMap, pageUrl, origin, pf);
      zip.file(urlToHtmlZipPath(pageUrl), rewritten);
      stats.ok++;
    }
    const slug = urlToHtmlZipPath(pageUrl).replace(/[/\\]/g, '_').replace('.html', '');
    for (const s of (data.inline_scripts || []))
      zip.file(`assets/js/inline_${slug}_${s.index}.js`, s.content);
    for (const s of (data.inline_styles || []))
      zip.file(`assets/css/inline_${slug}_${s.index}.css`, s.content);
  }

  // ── Netlify config ────────────────────────────────────────────────────────
  const isSPA = ['nextjs','nuxt','sveltekit','vite'].includes(framework);
  zip.file('_redirects', isSPA && visitedPages.size === 1
    ? '/*  /index.html  200\n'
    : '# Multi-page — no SPA fallback\n');

  zip.file('netlify.toml', `[build]\n  publish = "."\n\n` +
    `[[headers]]\n  for = "/_next/static/*"\n  [headers.values]\n    Cache-Control = "public, max-age=31536000, immutable"\n\n` +
    `[[headers]]\n  for = "/assets/*"\n  [headers.values]\n    Cache-Control = "public, max-age=31536000, immutable"\n\n` +
    `[[headers]]\n  for = "/*.html"\n  [headers.values]\n    Cache-Control = "public, max-age=0, must-revalidate"\n`);

  // ── Meta files ────────────────────────────────────────────────────────────
  const firstData = visitedPages.get(origin) || {};
  zip.file('_dump_meta/storage.json', JSON.stringify({
    url: origin, framework,
    cookies: firstData.cookies || '',
    localStorage: firstData.local_storage || {},
    sessionStorage: firstData.session_storage || {},
    dump_time: new Date().toISOString(),
  }, null, 2));

  zip.file('_dump_meta/manifest.json', JSON.stringify({
    version: '6.0',
    origin, framework,
    dump_time: new Date().toISOString(),
    pages_dumped: [...visitedPages.keys()],
    fetch_stats: stats,
    asset_count: Object.keys(assetMap).filter(k => !k.startsWith('/')).length,
  }, null, 2));

  zip.file('_dump_meta/verification_report.json', JSON.stringify({
    version: '6.0',
    dump_time: new Date().toISOString(),
    total_referenced: referenced.size,
    successfully_saved: referenced.size - stillMissed.length,
    missed_count: stillMissed.length,
    missed_urls: stillMissed.slice(0, 200), // cap at 200 for readability
    empty_files_in_zip: emptyFiles,
    inline_data_urls_skipped: inlineSkipped.count,
    interactive_clicks_total: stats.interactive_clicks,
    new_assets_found_via_clicks: stats.new_assets_from_clicks,
    pwa_manifests: pwaChecks,
    external_origins: [...new Set(
      [...referenced].map(u => { try { const p = new URL(u); return p.origin !== origin ? p.origin : null; } catch (_) { return null; } })
        .filter(Boolean)
    )].sort(),
  }, null, 2));

  // ── Generate ZIP ──────────────────────────────────────────────────────────
  const zipBase64 = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const domain = new URL(origin).hostname.replace(/[^a-z0-9]/gi, '_');
  const filename = `${domain}_v6_${Date.now()}.zip`;
  await chrome.downloads.download({
    url: 'data:application/zip;base64,' + zipBase64,
    filename,
    saveAs: false,
  });
  await chrome.storage.local.remove('dumper_progress');

  return { ok: true, stats, filename, framework };
}
