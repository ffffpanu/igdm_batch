# IG HiRes Downloader (Manifest V3 — Chrome & Firefox)

Adds download controls to Instagram posts, carousels, stories and profile pages.

## Install

**Chrome / Edge / Brave** — open `chrome://extensions`, enable *Developer mode*, click *Load unpacked*, select this folder.

**Firefox (128+)** — open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on…*, pick `manifest.json`.
Then open `about:addons` → *IG HiRes Downloader* → *Permissions* and grant the site access (MV3 host permissions are opt-in on Firefox).

## Test checklist

1. Log in to instagram.com, reload the tab after installing.
2. **Feed:** a pill (⬇ ▾) appears top-left of each post's media. Click ⬇ → current item downloads. Open ▾ for images / videos / whole post.
3. **Carousel:** swipe to slide 3, click ⬇ → slide 3 is saved. "Whole post" saves every slide.
4. **Post modal / `/p/…` / `/reel/…`:** same widget.
5. **Stories:** open a story → widget top-left of the story. ⬇ = current story item, menu = all images / videos / whole story (the user's whole reel).
6. **Profile:** a toolbar appears under the header. Scroll the grid first for "Loaded in grid" scope, or switch to "All posts (API)" in the popup.
7. Files land in `Downloads/Instagram/<user>/instagram_<user>_<timestamp>_<id>.<ext>`.
8. Extension popup shows live queue status, Cancel and Retry.
9. Debugging: DevTools console on instagram.com (filter `IG HiRes` / `IGHD`); service-worker console via `chrome://extensions` → *Inspect views*.

## How it works

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. `inject.js` runs in the page's MAIN world at `document_start`; `content.js` in the isolated world. Both `service_worker` and `scripts` background keys are declared so one manifest loads in Chrome and Firefox. |
| `inject.js` | Passively hooks `fetch`/`XHR` and scans inline JSON to capture media objects (`image_versions2`, `video_versions`, `carousel_media`) → forwards a slim copy to `content.js`. Also signals SPA navigation. No `chrome.debugger` banner needed. |
| `content.js` | Overlay UI (one fixed layer, positioned over the visible media), profile toolbar, `MutationObserver` + rAF scheduling, data resolution (API → sniffed cache → DOM), slide detection, bulk collection with throttling and retry/backoff. |
| `background.js` | Validated, throttled download queue (concurrency 3, staggered starts), waits for completion, retries ×3 with backoff, progress → tab + badge, filename builder. |
| `style.css` | Light/dark theming via Instagram's `html.__fb-dark-mode` class with OS fallback. |
| `popup.*` | Queue status, cancel/retry, settings. |

### Quality
For every item the largest entry of `image_versions2.candidates` / `video_versions` is chosen by pixel area. This is the best rendition Instagram's web API exposes — true uncompressed originals are never served.

### Permissions
`downloads` (save files), `storage` (settings), host permissions for Instagram + its CDNs. `activeTab` and `scripting` are declared as requested but not currently required by the code; remove them if you want the leanest permission set.

## Known limitations

- Uses Instagram's **private web API**; endpoints/field names can change without notice. Fallbacks (cache, DOM) degrade gracefully but may yield lower quality.
- Slide detection relies on `aria-label="Next"/"Go back"` (English UI) and pagination dots, then file-name matching. If it can't tell, it saves slide 1 and says so — use "whole post".
- Videos are the progressive MP4 Instagram provides (audio included). DASH-only streams aren't merged.
- `/reels/` full-screen feed isn't decorated; open the reel's own `/reel/<code>/` page.
- Bulk jobs are throttled on purpose. Very large profiles can trigger Instagram rate limits (HTTP 429) — the extension backs off and reports it; wait and retry.
- The queue lives in the background worker's memory; closing the browser mid-queue discards pending items.
- Private content is only accessible if your logged-in account can already see it.

## Responsible use
For personal archiving of content you're entitled to save. Respect creators' copyright and Instagram's Terms of Use; don't redistribute others' media.
