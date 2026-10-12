# Img Downloader

> A Manifest V3 extension for **Microsoft Edge / Chrome**: grab every image on the current page — **including multi-page articles** — filter by **real pixel dimensions**, then save them into a folder named after the page title or pack them into a ZIP.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4284F4)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![No build step](https://img.shields.io/badge/build-none%20required-brightgreen)]()
[![CI](https://github.com/soundandova/img-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/soundandova/img-downloader/actions/workflows/ci.yml)

[中文说明](README.md)

## What it solves

Most "bulk image downloader" extensions only scan `<img>` tags on the current page, which fails on:

- **Multi-page articles** (WordPress `post-page-numbers`, `/2/`, `rel=next`, `?page=2`…) — you end up clicking through pages one by one
- **Responsive images** (`srcset`) — you get the small variant instead of the large one
- **Images hosted on another domain**, sometimes behind hotlink protection
- **Messy filenames** — renamed by the server's `Content-Disposition`, non-ASCII names lost, everything dumped into one folder

This extension handles those cases while asking for as few permissions as possible.

## Features

- **Whole-article crawling** — detects pagination and walks every page (on by default; can be disabled or capped)
- **Real dimension filtering** — sends `Range: bytes=0-65535` and parses the **image file header** to get true width/height (PNG / JPEG / GIF / BMP / three WebP variants / AVIF / HEIC / SVG) without downloading the full image
- **Never silently drops images** — only filters images whose size is *known* to be below the threshold; unknown ones pass through and are labelled in the UI
- **Six image sources** — `img.currentSrc`, largest `srcset` candidate, `picture/source`, CSS `background-image`, `video[poster]`, lazy-load attributes, `a[href]` direct links
- **Reliable filenames** — enforced via `downloads.onDeterminingFilename` (`001_original-name_1200x1800.webp`); CJK characters preserved
- **Folder per page title** — `Downloads\<page title>\...` or `Downloads\<page title>.zip`
- **Original bytes** — no decode/re-encode; you get exactly what the server serves
- **Optional hotlink bypass** — temporarily adds a `declarativeNetRequest` rule to strip `Referer`, removed right after the task
- **Fully offline** — no telemetry, no external requests, no `webRequest` / `nativeMessaging` permissions

## Install

1. Clone or download this repository
2. Open `edge://extensions/` (or `chrome://extensions/`)
3. Enable **Developer mode** (bottom-left)
4. Click **Load unpacked** and select the **`dist/一键看图下载`** folder
   > The folder you pick must contain `manifest.json` directly
5. The icon is hidden behind the puzzle piece by default: click 🧩 next to the address bar → find the extension → click the eye icon to pin it

Source lives in `extension/`; `dist/` is an identical copy kept in sync by `node tools/build-dist.js`.

## Usage

1. Open the target page and click the extension icon
2. Click **扫描页面** (Scan page) — it collects the current page, crawls every paginated page, and probes real image sizes
3. Review the thumbnail grid (size / format / byte size / source domain; sortable and filterable)
4. Either **下载选中** (Download selected) → `Downloads\<page title>\001_name_1200x1800.webp`, or **打包 ZIP** → `Downloads\<page title>.zip`

The UI is currently in Chinese; an English locale is on the roadmap.

## Known limitations

- Pagination follows only links in the **same path family** (`/post/2/`, `/post/3/`…); it will not crawl to unrelated articles
- At most 800 images are size-probed per run; the rest pass through as "size unknown"
- **Do not close the popup while a ZIP is being built** — the ZIP is assembled in the popup (this avoids the `offscreen` permission); use "Download selected" instead
- CSS background scanning is limited to the first 5000 elements inside the content container
- Images inside `iframe`s are not collected (`all_frames` is off)
- Login-gated or paid content depends on the session already present in your browser

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `tabs` | Read the current tab URL; collect only on click |
| `scripting` | Inject the collector on demand (no persistent content script) |
| `storage` | Save settings and job progress |
| `downloads` | Save images/ZIP and enforce filenames |
| `declarativeNetRequest` | Only when "bypass hotlink protection" is enabled; session rules, removed after the task |
| `host_permissions: <all_urls>` | Fetch paginated HTML and image bytes to determine dimensions |

The extension makes **no external network requests** — no telemetry, no analytics, no remote config.

## Development

No build step. Edit files under `extension/`, then hit the reload ↻ button on the extension card.

```bash
# Requires Node 18+ (uses global WebSocket / fetch). The extension itself has zero runtime deps.

node tools/fixture-site.js 8099                        # local paginated fixture site
node tools/test-parser.js                              # parser unit tests (39)
node tools/e2e.js http://127.0.0.1:8099/article/1/     # real-browser end-to-end (39)
node tools/build-dist.js --check                       # dist must match extension/
node tools/perf.js [URL]                               # phase timings + progress-accounting checks
```

Test tools auto-detect a local Edge/Chrome. Override with `BROWSER_PATH`, `BROWSER_PORT`, `DOWNLOAD_DIR`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## Disclaimer

Use this tool only for content you are entitled to download. Respect each site's terms of service and copyright law, and keep request rates reasonable. You are responsible for compliance.

## License

[MIT](LICENSE)
