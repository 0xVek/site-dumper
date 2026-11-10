// popup.js v6 — seed page properly prepared before dump

const btn           = document.getElementById('dumpBtn');
const statusEl      = document.getElementById('status');
const urlEl         = document.getElementById('currentUrl');
const statsRow      = document.getElementById('statsRow');
const maxPagesEl    = document.getElementById('maxPages');
const maxPagesValEl = document.getElementById('maxPagesVal');
const frameworkPill = document.getElementById('frameworkPill');

const FRAMEWORK_LABELS = {
  nextjs:    '⬛ Next.js',
  nuxt:      '🟢 Nuxt',
  sveltekit: '🟠 SvelteKit',
  vite:      '🟣 Vite',
  static:    '📄 Static',
};

let currentTab = null;

function cleanOrigin(url) {
  try { return new URL(url).origin; }
  catch (_) { return url; }
}

// On popup open — quick framework detect only (no heavy work)
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  currentTab = tabs[0];
  if (!currentTab) return;
  urlEl.textContent = currentTab.url;

  chrome.tabs.sendMessage(currentTab.id, { action: 'detect' }, (res) => {
    if (res?.framework) {
      frameworkPill.textContent = FRAMEWORK_LABELS[res.framework] || res.framework;
      frameworkPill.className   = 'framework-pill ' + res.framework;
      frameworkPill.style.display = 'block';
    }
  });
});

maxPagesEl.addEventListener('input', () => {
  maxPagesValEl.textContent = maxPagesEl.value;
});

let poller = null;
function startPoll() {
  poller = setInterval(() => {
    chrome.storage.local.get('dumper_progress', (res) => {
      if (res.dumper_progress) setStatus('running', '⟳  ' + res.dumper_progress);
    });
  }, 500);
}
function stopPoll() { if (poller) { clearInterval(poller); poller = null; } }

btn.addEventListener('click', async () => {
  if (!currentTab) return;
  btn.disabled = true;
  statsRow.style.display = 'none';
  setStatus('running', '⟳  Phase 1/4: Forcing full page load (scroll + lazy + interactions)...');
  startPoll();

  try {
    // ── STEP 1: prepare() on seed page — awaits scroll + clicks + network idle
    setStatus('running', '⟳  Preparing page: scroll, force-load all assets, trigger interactions...');
    const prepStats = await chrome.tabs.sendMessage(currentTab.id, { action: 'prepare' });

    if (!prepStats) {
      setStatus('error', '✗  Content script not ready. Reload the page and try again.');
      btn.disabled = false; stopPoll(); return;
    }

    // ── STEP 2: collect() — DOM is now fully settled
    setStatus('running', '⟳  Collecting all assets...');
    const assets = await chrome.tabs.sendMessage(currentTab.id, { action: 'collect' });

    if (!assets) {
      setStatus('error', '✗  Collection failed. Reload the page and try again.');
      btn.disabled = false; stopPoll(); return;
    }

    // Apply user options
    if (!document.getElementById('optJS').checked)     { assets.scripts = []; assets.inline_scripts = []; }
    if (!document.getElementById('optCSS').checked)    { assets.styles  = []; assets.inline_styles  = []; }
    if (!document.getElementById('optIMG').checked)    { assets.images  = []; assets.image_map = {}; }
    if (!document.getElementById('optFONT').checked)   assets.fonts   = [];
    if (!document.getElementById('optSTORE').checked)  { assets.local_storage = {}; assets.session_storage = {}; assets.cookies = ''; }
    if (!document.getElementById('optINLINE').checked) { assets.inline_scripts = []; assets.inline_styles = []; }

    const total = assets.scripts.length + assets.styles.length +
                  (assets.images || []).length + assets.fonts.length;

    setStatus('running',
      `⟳  Found ${total} assets · ${prepStats.clicks || 0} interactions · Starting crawl...`);

    document.getElementById('statJS').textContent  = assets.scripts.length;
    document.getElementById('statCSS').textContent = assets.styles.length;
    document.getElementById('statIMG').textContent = (assets.images || []).length;
    statsRow.style.display = 'flex';

    const origin = cleanOrigin(currentTab.url);

    // ── STEP 3: Send to background for crawl + fetch + package
    const result = await chrome.runtime.sendMessage({
      action:  'dump',
      data:    assets,
      prepareStats: prepStats,
      origin,
      options: { maxPages: parseInt(maxPagesEl.value, 10) },
    });

    stopPoll();

    if (result?.ok) {
      document.getElementById('statOK').textContent     = result.stats.ok;
      document.getElementById('statFAIL').textContent   = result.stats.fail;
      document.getElementById('statPAGES').textContent  = result.stats.pages;
      document.getElementById('statCLICK').textContent  = result.stats.interactive_clicks || 0;
      document.getElementById('statFOUND').textContent  = result.stats.new_assets_from_clicks || 0;
      document.getElementById('statMISSED').textContent = result.stats.missed || 0;
      statsRow.style.display = 'flex';

      const missedCount = result.stats.missed || 0;
      const missedText = missedCount > 0
        ? ` · ⚠ ${missedCount} missed (see _dump_meta/verification_report.json)`
        : ' · ✓ All assets verified';

      setStatus('done',
        `✓  ${result.stats.pages} pages · ${result.stats.ok} assets${missedText}\nZIP ready — drop on Netlify to deploy.`
      );
    } else {
      setStatus('error', '✗  ' + (result?.error || 'Unknown error'));
    }

  } catch (e) {
    stopPoll();
    setStatus('error', '✗  ' + e.message);
  }

  btn.disabled = false;
});

function setStatus(type, msg) {
  statusEl.className   = type;
  statusEl.textContent = msg;
  statusEl.style.display = 'block';
}
