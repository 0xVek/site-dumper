// content.js v6 — Maximum Force Extractor
// Strategy: FORCE every lazy asset to load, WAIT for network idle, THEN collect.
// No asset left behind.

(function () {
  if (window.__siteDumperV6Injected) return;
  window.__siteDumperV6Injected = true;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // Query across document + all shadow roots
  function queryAll(selector) {
    const results = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      try {
        root.querySelectorAll(selector).forEach(el => {
          if (!results.includes(el)) results.push(el);
        });
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) roots.push(el.shadowRoot);
        });
      } catch (_) {}
    }
    return results;
  }

  function toAbs(url) {
    if (!url || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(url)) return null;
    try { return new URL(url, location.href).href; }
    catch (_) { return null; }
  }

  function resolveNextImage(url) {
    try {
      const u = new URL(url, location.href);
      if (u.pathname === '/_next/image') {
        const raw = u.searchParams.get('url');
        if (raw) return raw.startsWith('http') ? raw : location.origin + raw;
      }
    } catch (_) {}
    return null;
  }

  // ── Framework detection ──────────────────────────────────────────────────────
  function detectFramework() {
    if (document.getElementById('__NEXT_DATA__') || window.__NEXT_DATA__ ||
        document.querySelector('script[src*="/_next/"]')) return 'nextjs';
    if (window.__NUXT__ || document.querySelector('#__nuxt') ||
        document.querySelector('script[src*="/_nuxt/"]')) return 'nuxt';
    if (document.querySelector('[data-svelte-h]') ||
        document.querySelector('script[src*="/_app/"]')) return 'sveltekit';
    if (document.querySelector('#app') && document.querySelector('script[src*="/assets/"]')) return 'vite';
    return 'static';
  }

  // ── STEP 1: Force ALL lazy images to load eagerly ────────────────────────────
  function forceLazyImages() {
    queryAll('img[loading="lazy"], img[data-src], img[data-lazy], img[data-original]').forEach(el => {
      // Remove lazy loading attribute
      el.removeAttribute('loading');
      el.setAttribute('loading', 'eager');

      // Handle data-src lazy loaders
      const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-lazy') || el.getAttribute('data-original');
      if (dataSrc && !el.src.startsWith('http')) {
        el.src = dataSrc;
      }

      // Handle srcset lazy
      const dataSrcset = el.getAttribute('data-srcset');
      if (dataSrcset && !el.srcset) el.srcset = dataSrcset;
    });

    // Force background-image lazy loaders (Intersection Observer pattern)
    queryAll('[data-bg], [data-background], [data-background-image]').forEach(el => {
      const bg = el.getAttribute('data-bg') ||
                 el.getAttribute('data-background') ||
                 el.getAttribute('data-background-image');
      if (bg) el.style.backgroundImage = `url("${bg}")`;
    });

    // Force picture source elements
    queryAll('source[data-srcset]').forEach(el => {
      if (!el.srcset) el.srcset = el.getAttribute('data-srcset');
    });

    // Force video poster + source
    queryAll('video[data-poster]').forEach(el => {
      el.poster = el.getAttribute('data-poster');
    });
  }

  // ── STEP 2: Scroll simulation with dynamic height tracking ───────────────────
  async function fullScroll() {
    // Force images to load before scroll
    forceLazyImages();

    const STEP = 250;
    const STEP_DELAY = 60;
    let y = 0;
    let lastH = 0;
    let stableCount = 0;

    while (true) {
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0
      );

      window.scrollTo(0, y);
      await delay(STEP_DELAY);

      // Re-trigger lazy images every 1000px scroll
      if (y % 1000 < STEP) forceLazyImages();

      y += STEP;

      if (h === lastH) {
        stableCount++;
        if (y >= h && stableCount >= 3) break;
      } else {
        stableCount = 0;
        lastH = h;
      }

      if (y > 150000) break; // safety cap: 150k px
    }

    window.scrollTo(0, 0);
    await delay(300);
  }

  // ── STEP 3: Wait for network idle using PerformanceObserver ─────────────────
  function waitNetworkIdle(quietMs = 800, maxMs = 10000) {
    return new Promise(resolve => {
      let quietTimer = null;
      let resolved = false;
      const pendingUrls = new Set();

      const hardTimer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(); }
      }, maxMs);

      function resetQuiet() {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          if (!resolved && pendingUrls.size === 0) {
            resolved = true;
            clearTimeout(hardTimer);
            resolve();
          }
        }, quietMs);
      }

      try {
        const po = new PerformanceObserver(list => {
          list.getEntries().forEach(e => {
            pendingUrls.delete(e.name);
          });
          resetQuiet();
        });
        po.observe({ entryTypes: ['resource'] });
      } catch (_) {}

      // Also watch for DOM mutations (new elements might trigger new fetches)
      try {
        const mo = new MutationObserver(() => resetQuiet());
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'srcset', 'data-src'] });
        setTimeout(() => mo.disconnect(), maxMs);
      } catch (_) {}

      resetQuiet();
    });
  }

  // ── STEP 4: DOM settle wait ──────────────────────────────────────────────────
  function waitDomSettle(quietMs = 500, maxMs = 4000) {
    return new Promise(resolve => {
      let timer = null;
      const hard = setTimeout(() => { obs.disconnect(); resolve(); }, maxMs);
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { obs.disconnect(); clearTimeout(hard); resolve(); }, quietMs);
      });
      obs.observe(document.documentElement, { subtree: true, childList: true });
      timer = setTimeout(() => { obs.disconnect(); clearTimeout(hard); resolve(); }, quietMs);
    });
  }

  // ── STEP 5: Interactive element clicker ─────────────────────────────────────
  const CLICK_SELECTORS = [
    '[role="tab"]:not([aria-selected="true"])',
    'details > summary',
    '[aria-expanded="false"]',
    '[data-state="closed"]',
    '[data-state="inactive"]',
    '[data-toggle]',
    '[aria-controls]:not([aria-expanded="true"])',
  ].join(',');

  // Safe button-like things that expand content
  const EXPAND_BUTTON_PATTERN = /tab|accordion|expand|collapse|show.?more|read.?more|toggle|section|panel|open|reveal/i;

  const DANGER_PATTERN = /buy|purchase|checkout|pay|delete|remove|logout|sign.?out|submit|send|confirm|place.?order|book|reserve/i;

  async function triggerInteractiveElements() {
    const clicked = new WeakSet();
    let clickCount = 0;
    let newAssets = 0;
    const MAX_CLICKS = 80;

    const getSnapshot = () => {
      const s = new Set();
      queryAll('img[src],script[src],link[href],source[src]').forEach(el => {
        const v = el.src || el.href || el.getAttribute('src') || el.getAttribute('href');
        if (v && !v.startsWith('data:')) s.add(v);
      });
      return s;
    };

    // Keep re-querying after each click (new elements might appear)
    for (let round = 0; round < 10 && clickCount < MAX_CLICKS; round++) {
      let clickedThisRound = 0;
      const candidates = queryAll(CLICK_SELECTORS);

      for (const el of candidates) {
        if (clickCount >= MAX_CLICKS) break;
        if (clicked.has(el)) continue;
        if (!el.isConnected) continue;

        // Safety checks
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (DANGER_PATTERN.test(text)) continue;

        // For generic buttons, only click if they look like expanders
        if (el.matches('button,[role="button"]') && !el.matches(CLICK_SELECTORS)) {
          if (!EXPAND_BUTTON_PATTERN.test(text + ' ' + (el.className || ''))) continue;
        }

        clicked.add(el);
        const before = getSnapshot();

        try {
          el.click();
          clickCount++;
          clickedThisRound++;
        } catch (_) {}

        await delay(350);
        await waitDomSettle(300, 1500);

        const after = getSnapshot();
        after.forEach(url => { if (!before.has(url)) newAssets++; });

        // Force lazy images that may have appeared
        forceLazyImages();
      }

      if (clickedThisRound === 0) break; // no new clickable things found
      await delay(200);
    }

    return { clickCount, newAssets };
  }

  // ── STEP 6: Full asset collection ───────────────────────────────────────────
  function collectAll() {
    const framework = detectFramework();
    const origin = location.origin;
    const seenImages = new Set();

    const assets = {
      framework,
      html: [{ url: location.href, content: document.documentElement.outerHTML }],
      scripts: [],
      styles: [],
      images: [],
      fonts: [],
      other: [],
      inline_scripts: [],
      inline_styles: [],
      local_storage: {},
      session_storage: {},
      cookies: document.cookie,
      internal_links: [],
      image_map: {},
      _meta: {},
    };

    // Scripts
    queryAll('script[src]').forEach(el => {
      const abs = toAbs(el.src);
      if (abs) assets.scripts.push(abs);
    });

    // Inline scripts
    queryAll('script:not([src])').forEach((el, i) => {
      if (el.textContent.trim()) assets.inline_scripts.push({ index: i, content: el.textContent });
    });

    // Stylesheets
    queryAll('link[rel="stylesheet"],link[rel="preload"][as="style"]').forEach(el => {
      const abs = toAbs(el.href);
      if (abs) assets.styles.push(abs);
    });

    // Inline styles
    queryAll('style').forEach((el, i) => {
      if (el.textContent.trim()) assets.inline_styles.push({ index: i, content: el.textContent });
    });

    // Images — all variants
    const imgSelectors = 'img[src],img[srcset],img[data-src],img[data-srcset],' +
                         'source[src],source[srcset],source[data-srcset],' +
                         'video[poster],video[src],audio[src]';
    queryAll(imgSelectors).forEach(el => {
      const attrs = ['src', 'data-src', 'data-lazy', 'data-original', 'poster'];
      attrs.forEach(attr => {
        const val = el.getAttribute(attr);
        if (!val) return;
        const abs = toAbs(val);
        if (!abs || seenImages.has(abs)) return;
        seenImages.add(abs);
        const real = resolveNextImage(abs);
        if (real) {
          assets.image_map[abs] = real;
          assets.images.push({ url: real, originalSrc: abs });
        } else {
          assets.images.push({ url: abs, originalSrc: abs });
        }
      });

      // srcset parsing
      const srcsets = [el.getAttribute('srcset'), el.getAttribute('data-srcset')];
      srcsets.forEach(srcset => {
        if (!srcset || srcset.startsWith('data:')) return;
        srcset.split(',').forEach(s => {
          const raw = s.trim().split(/\s+/)[0];
          if (!raw) return;
          const abs = toAbs(raw);
          if (!abs || seenImages.has(abs)) return;
          seenImages.add(abs);
          const real = resolveNextImage(abs);
          if (real) {
            assets.image_map[abs] = real;
            assets.images.push({ url: real, originalSrc: abs });
          } else {
            assets.images.push({ url: abs, originalSrc: abs });
          }
        });
      });
    });

    // CSS background images — computed style
    queryAll('*').forEach(el => {
      try {
        const styles = [getComputedStyle(el).backgroundImage];
        // Also check inline style
        if (el.style && el.style.backgroundImage) styles.push(el.style.backgroundImage);
        styles.forEach(bg => {
          if (!bg || bg === 'none') return;
          const matches = bg.matchAll(/url\(["']?([^"')]+)["']?\)/g);
          for (const m of matches) {
            const abs = toAbs(m[1]);
            if (abs && !seenImages.has(abs)) {
              seenImages.add(abs);
              assets.images.push({ url: abs, originalSrc: abs });
            }
          }
        });
      } catch (_) {}
    });

    // data-bg attributes
    queryAll('[data-bg],[data-background],[data-background-image]').forEach(el => {
      const bg = el.getAttribute('data-bg') ||
                 el.getAttribute('data-background') ||
                 el.getAttribute('data-background-image');
      const abs = toAbs(bg);
      if (abs && !seenImages.has(abs)) {
        seenImages.add(abs);
        assets.images.push({ url: abs, originalSrc: abs });
      }
    });

    // Preload images
    queryAll('link[rel="preload"][as="image"]').forEach(el => {
      const abs = toAbs(el.href);
      if (!abs || seenImages.has(abs)) return;
      seenImages.add(abs);
      const real = resolveNextImage(abs);
      if (real) {
        assets.image_map[abs] = real;
        assets.images.push({ url: real, originalSrc: abs });
      } else {
        assets.images.push({ url: abs, originalSrc: abs });
      }
    });

    // Fonts
    queryAll('link[rel="preload"][as="font"],link[rel="preconnect"]').forEach(el => {
      const abs = toAbs(el.href);
      if (abs && /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(abs)) assets.fonts.push(abs);
    });

    // PWA manifest + icons + apple touch icons
    queryAll('link[rel="manifest"],link[rel~="icon"],link[rel="apple-touch-icon"],link[rel="shortcut icon"]').forEach(el => {
      const abs = toAbs(el.href);
      if (abs) assets.other.push(abs);
    });

    // Performance API — catches EVERYTHING that loaded (XHR, fetch, dynamic imports)
    if (window.performance?.getEntriesByType) {
      window.performance.getEntriesByType('resource').forEach(entry => {
        const url = entry.name;
        if (!url || /^(data:|blob:)/i.test(url)) return;
        const abs = toAbs(url);
        if (!abs) return;

        if (/\.m?js(\?|$)/i.test(url)) assets.scripts.push(abs);
        else if (/\.css(\?|$)/i.test(url)) assets.styles.push(abs);
        else if (/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|tiff?)(\?|$)/i.test(url)) {
          if (!seenImages.has(abs)) {
            seenImages.add(abs);
            assets.images.push({ url: abs, originalSrc: abs });
          }
        }
        else if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) assets.fonts.push(abs);
        else if (/\.(json|webmanifest|pdf|wasm|mp4|webm|ogg|mp3|wav)(\?|$)/i.test(url)) assets.other.push(abs);
      });
    }

    // Internal links
    queryAll('a[href]').forEach(el => {
      try {
        const abs = new URL(el.href, location.href).href;
        if (abs.startsWith(origin) && !abs.includes('#') &&
            !/^(mailto:|tel:)/.test(abs)) {
          assets.internal_links.push(abs);
        }
      } catch (_) {}
    });

    // Shadow DOM: preserve markup as templates for HTML reconstruction
    const shadowDumps = [];
    queryAll('*').forEach((host, i) => {
      if (host.shadowRoot) {
        shadowDumps.push(`<template data-shadow-host="${i}">${host.shadowRoot.innerHTML}</template>`);
      }
    });
    if (shadowDumps.length) {
      assets.html[0].content = assets.html[0].content.replace(
        '</body>', shadowDumps.join('\n') + '</body>'
      );
    }

    // Storage
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        assets.local_storage[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        assets.session_storage[k] = sessionStorage.getItem(k);
      }
    } catch (_) {}

    // Dedup
    assets.scripts = [...new Set(assets.scripts)].filter(Boolean);
    assets.styles  = [...new Set(assets.styles)].filter(Boolean);
    assets.fonts   = [...new Set(assets.fonts)].filter(Boolean);
    assets.other   = [...new Set(assets.other)].filter(Boolean);
    assets.internal_links = [...new Set(assets.internal_links)];
    const seenFinal = new Set();
    assets.images = assets.images.filter(img => {
      if (!img?.url || seenFinal.has(img.url)) return false;
      seenFinal.add(img.url);
      return true;
    });

    return assets;
  }

  // ── MASTER prepare function ──────────────────────────────────────────────────
  // This is what popup calls BEFORE collect.
  // It BLOCKS until everything is fully loaded and all interactions done.
  async function prepare() {
    const t0 = Date.now();

    // Phase A: Force lazy, scroll full page, wait for network idle
    await fullScroll();
    await waitNetworkIdle(1000, 12000);
    await waitDomSettle(600, 4000);

    // Phase B: Trigger interactive elements (tabs, accordions, dropdowns)
    const clickStats = await triggerInteractiveElements();

    // Phase C: Final lazy force + network idle after all clicks
    forceLazyImages();
    await waitNetworkIdle(800, 8000);
    await waitDomSettle(500, 3000);

    // Phase D: Scroll once more (content may have expanded from clicks)
    await fullScroll();
    await waitNetworkIdle(600, 5000);

    return {
      ok: true,
      elapsed_ms: Date.now() - t0,
      clicks: clickStats.clickCount,
      new_assets_from_clicks: clickStats.newAssets,
    };
  }

  // ── Message listener ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // Quick framework check (popup init — no heavy work)
    if (msg.action === 'detect') {
      sendResponse({ framework: detectFramework() });
      return false;
    }

    // Full prepare: scroll + interact + network idle — ASYNC, blocks until done
    if (msg.action === 'prepare') {
      prepare().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true; // keep message channel open
    }

    // Collect: synchronous snapshot of current DOM state
    if (msg.action === 'collect') {
      try {
        sendResponse(collectAll());
      } catch (e) {
        sendResponse({ _error: e.message });
      }
      return false;
    }
  });

})();
