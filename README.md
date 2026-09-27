# imgbrowse

A local image browser for images in a folder tree. Targets macOS and Linux.
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

Open folders or select an image to read. The viewer includes all descendants in
natural filename order. Use left/right arrows to turn pages, Escape to close,
and the size selector to fit or zoom. Viewer options contain the other shortcuts.

Switch between previews and a name list; optionally include subfolders. Filtering
matches names in the current folder. URLs can be bookmarked, and browser history
restores grid positions. Refresh picks up filesystem changes.

Supports JPG, JPEG, PNG, GIF, WebP, and BMP. Hidden files and symlinks are ignored.
The app is read-only, with no index or persistent cache. Folder discovery is
incremental; thumbnails use a bounded memory cache.

## Development

Python HTTP, traversal, and thumbnail code lives in `image_browser/`. Browser
modules are in `static/`, coordinated by `gallery.js`. No frontend build is needed.

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
