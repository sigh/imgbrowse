# imgbrowse

A local image browser for loose images at any folder depth. Targets macOS and Linux.
Requires Python 3.9+ and Pillow.

## Run

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 imgbrowse.py 8080 "/path/to/images"
```

Open `http://127.0.0.1:8080/`. The port defaults to `8080` and the directory defaults
to the current directory. A directory alone is also accepted. Stop with Ctrl+C.
The server currently listens on localhost.

## Browse

- Click a folder to open it; use the path at the top to navigate to a parent.
- Each folder has one preview: its first direct image, or an image found by following
  only its first child branch. Empty folders stay visible; no preview does not mean
  the whole folder is empty.
- **Include subfolders in grid** shows a continuous image grid grouped by folder.
- Name filtering applies to immediate folder contents and is disabled in recursive
  grid mode.
- Click an image, a folder's **View** button, or **View all images** to open the viewer.
  It always traverses the entire selected folder, including descendants, regardless
  of the grid's settings or filter.
- Use arrow keys, the mouse wheel, buttons, or nearby thumbnails to move between
  images. At either end, press the same arrow again or pause briefly and scroll
  again to wrap. Holding a key or continued scroll momentum won't wrap. The wrap
  button is also available. Escape closes the viewer and cancels pending loading.
- Bookmark the URL to restore a folder or image and its browsing context. Closing
  the viewer preserves the underlying grid position. Image navigation replaces the
  current history entry; Back returns to the preceding view.
- Refresh to discover filesystem changes. There is no collection-wide index or
  saved reading state.

Images use natural filename order (`page2` before `page10`). Recursive order visits
images directly in a folder, then its child folders in natural order. Supported
formats: JPG, JPEG, PNG, GIF, WebP, and BMP. Hidden entries and symbolic links are
ignored. Source files are never modified.

## How it stays responsive

Folders are listed on demand. Descendant traversal runs in bounded pages; only
nearby grid rows and thumbnails are rendered. The viewer opens a bookmarked image
directly and discovers neighbors from that location. Thumbnail generation uses
Pillow, with up to four resizing tasks separate from folder discovery. Visible
previews are prioritized from top to bottom ahead of offscreen rows. Encoded
thumbnails are reused in a 64 MiB memory cache and the browser's HTTP cache; the
app creates no persistent cache or database. Changed files invalidate their
cached thumbnails automatically.

Thumbnails reduce browser downloads and decoded-image memory. The first request
still reads the original from storage and pays the resizing cost; they do not
eliminate the source read. A loading message in the viewer appears only after a
noticeable delay, rather than flashing between every pair of images.

Listing a very large single folder or reading unavailable storage can still be
slow. Pending client work is cancelled when leaving a view; an operating-system
filesystem read already in progress cannot be interrupted. Recursive browsing
retains discovered paths in memory, while image data and rendered elements are
bounded. This prototype still needs performance measurements against a large collection.

The expanded folder-preview layout is deferred.

## Code map

There is no frontend build step. The browser loads native JavaScript modules.

| File | Responsibility |
| --- | --- |
| `imgbrowse.py` | Command-line arguments and server startup |
| `image_browser/catalog.py` | Safe paths, folder listings, previews, incremental traversal |
| `image_browser/thumbnails.py` | Thumbnail generation and bounded memory cache |
| `image_browser/server.py` | HTTP routes, request validation, response headers |
| `gallery.js` | App setup and navigation between views |
| `static/state.js`, `static/api.js` | URL state and filesystem API client |
| `static/folder-grid.js`, `static/grid-layout.js` | Folder discovery, virtual rows, label sizing |
| `static/image-viewer.js` | Lightbox navigation, gestures, and neighbor discovery |
| `static/preview-loader.js`, `static/dom.js` | Preview scheduling and resource cleanup |
| `template.html`, `gallery.css` | Markup, component styles, theme and layout variables |

Each view owns its request lifetimes. Disposing a task scope aborts pending requests
and releases blob URLs. The URL defines navigation state; view modules retain only
the transient data needed for rendering and browsing.

## Check

```sh
python3 -B -m unittest discover -s tests -v
node --test tests/*.test.js
```

Optional end-to-end checks require Chrome/Chromium and Node 22+:

```sh
python3 -B tests/browser_smoke.py
```

Set `CHROME_BIN` if Chrome is not in a standard location. The smoke test starts a
temporary server and browser profile with generated images, then removes them.
Use `--screenshots /tmp/imgbrowse-check` to retain screenshots.
