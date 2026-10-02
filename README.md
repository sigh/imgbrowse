# imgbrowse

A local image browser for images in a folder tree. Targets macOS and Linux.
Requires Python 3.9+ and Pillow.

## Install and run

From a checkout, run `pipx install .`, or install a shared wheel:

```sh
pipx install /path/to/imgbrowse-0.1.0-py3-none-any.whl
imgbrowse "/path/to/images"
imgbrowse "/path/to/images" --host 0.0.0.0 --port 8080
```

Open `http://127.0.0.1:8080/` locally. With `--host 0.0.0.0`, other devices can
browse the selected folder at `http://<this-computer-IP>:8080/`. LAN access has no
login. Each computer can run its own instance with any local or mounted directory.
The default root is the current directory; stop with Ctrl+C.
FFmpeg/ffprobe are optional for video previews and duration labels.

To build a wheel to share (no publishing required):

```sh
python3 -m pip wheel . --no-deps --wheel-dir dist
```

Reinstall an updated wheel with `pipx install --force /path/to/new.whl`.

## Browse

Open folders or select an image to read. The viewer includes all descendants in
natural filename order. Use left/right arrows to turn pages, Escape to return to Browse,
and the size selector to fit or zoom. Scroll again at an image edge to turn pages.

The fixed folder/grid/play group opens Browse, collection Overview, or View.
Browse shows immediate children as previews or a name list; its filter matches
names. Overview includes descendant media; selecting an item opens View. View's
thumbnail button shows or hides the tray. Sizing, thumbnail visibility, and
thumbnail size are remembered for the tab session; viewer URLs restore their
own presentation. Browse restores the opening folder, filter, layout, position,
and focus. Breadcrumbs navigate to another folder. Back/Forward restores screen
and grid position; Refresh picks up filesystem changes.

Supports JPG, JPEG, PNG, GIF, WebP, and BMP, including images inside ZIP and CBZ
archives. Loose MP4, M4V, WebM, OGV, and MOV videos use native browser playback
(codec support depends on the browser), with on-demand thumbnails when optional `ffmpeg` is on PATH; otherwise a play icon. Archives appear as folders; their contents are read on demand without
extraction. Hidden files and symlinks are ignored.
The app is read-only, with no index or persistent cache. Folder discovery is
incremental; bounded memory caches reuse listings, previews, and nearby images.
Refresh reloads the current scope from disk.

## Development

Python HTTP, traversal, and thumbnail code lives in `image_browser/`. Browser
assets are in `image_browser/web/`. No frontend build is needed.
For source development, install with `python3 -m pip install -e .` in a virtual
environment and run `python3 imgbrowse.py "/path/to/images"`.

## Check

```sh
python3 -B -m unittest discover -s tests -v
node --test tests/*.test.js
```

Optional end-to-end checks require Chrome/Chromium and Node 22+:

```sh
python3 -B tests/browser_smoke.py --performance
```

Set `CHROME_BIN` if Chrome is not in a standard location. The smoke test starts a
temporary server and browser profile with generated images, then removes them.
Use `--screenshots /tmp/imgbrowse-check` to retain screenshots.
