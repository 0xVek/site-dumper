# 🗜 Site Dumper

> Force-load every asset on any page, then export a fully deployable ZIP — in one click.



![Version](https://img.shields.io/badge/version-6.0-6c8fff?style=flat-square)




![Manifest](https://img.shields.io/badge/manifest-v3-4ade80?style=flat-square)




![License](https://img.shields.io/badge/license-MIT-a78bfa?style=flat-square)



Site Dumper is a Chrome extension that scrolls, clicks, and force-loads every lazy
asset on a page — then packages the entire site into a clean ZIP you can drop
straight onto Netlify.

---

## ✨ Features

- **Force-loads everything** — lazy images, shadow DOM assets, Intersection Observer
  triggers, `data-src` patterns, background images, video posters
- **Framework-aware** — detects Next.js, Nuxt, SvelteKit, Vite, and static sites
  automatically
- **Multi-page crawl** — crawl up to 20 linked pages in one dump
- **Interaction simulation** — clicks dropdowns, accordions, tabs to surface hidden assets
- **Configurable output** — toggle JS, CSS, images, fonts, storage, and inline assets
- **Verification report** — `_dump_meta/verification_report.json` logs every missed asset
- **Netlify-ready ZIP** — drop the output directly on [Netlify Drop](https://app.netlify.com/drop)

---

## 📦 Install

1. Clone or download this repo
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `site_dumper_v6/` folder

---

## 🚀 Usage

1. Navigate to any website
2. Click the Site Dumper icon in your toolbar
3. Configure what to include (JS, CSS, images, fonts, storage)
4. Set how many pages to crawl (1–20)
5. Hit **⬇ Dump Site**
6. Drop the downloaded ZIP on [Netlify Drop](https://app.netlify.com/drop)

---

## 🗂 Project Structure

---

## ⚙️ How It Works

**Phase 1 — Force Load**
Scrolls the full page, removes lazy-loading attributes, fires Intersection Observers,
simulates clicks on interactive elements, and waits for network idle.

**Phase 2 — Collect**
Walks the fully-loaded DOM — including shadow roots — and collects every asset URL
(scripts, stylesheets, images, fonts, storage data, inline content).

**Phase 3 — Crawl**
Visits linked same-origin pages (up to your configured limit), repeats phases 1–2 on each.

**Phase 4 — Package**
Fetches all collected assets, rewrites URLs to relative paths, and bundles everything
into a deployable ZIP with a verification report.

---

## 🌐 Supported Frameworks

| Framework | Detection Method |
|-----------|-----------------|
| Next.js | `__NEXT_DATA__` / `/_next/` scripts |
| Nuxt | `__NUXT__` / `#__nuxt` element |
| SvelteKit | `[data-svelte-h]` / `/_app/` scripts |
| Vite | `#app` + `/assets/` scripts |
| Static HTML | Fallback |

---

## 📄 License

MIT
