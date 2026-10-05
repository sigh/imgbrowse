# imgbrowse

A read-only image and video browser for folders and ZIP/CBZ archives.
Runs on macOS and Linux with Python 3.9+ and Pillow. Install FFmpeg/ffprobe
for video previews and duration labels.

## Install and run

From a checkout:

```sh
pipx install .
imgbrowse "/path/to/images"
```

Open <http://127.0.0.1:8080/>. Use `-p PORT` to change the port or
`--host 0.0.0.0` to share on the LAN without a login.
Repeat `--exclude NAME` to omit exact, case-sensitive names at any depth.
Hidden names and symlinks are omitted. See `imgbrowse --help` for options.

## Using the browser

- **Browse** shows the current folder; **Overview** includes its descendants.
- **View** offers single-image, thumbnail, and continuous-scroll layouts.
- Sort by name or modification date, and use **↑ / ↓** to reverse the order.
- Use left/right arrows to turn pages, Escape to return to Browse, and **− / +**
  to zoom. Click an image to toggle 100% sizing.
- Open **Info** in the sidebar for metadata and the full path.
  Use **Refresh** to pick up changes on disk.

Supports JPG, JPEG, PNG, GIF, WebP, and BMP, including archive members.
Loose MP4, M4V, WebM, OGV, and MOV videos play when the browser supports their
codecs. Archives are read without extraction.

## Docker

```sh
docker build -t imgbrowse .
docker run --rm --init --read-only \
  --user "$(id -u):$(id -g)" --publish 8080:8080 \
  --mount type=bind,src=/path/to/images,dst=/media,readonly \
  imgbrowse
```

The image includes FFmpeg. The selected user needs read access to the collection.

## Development

In a virtual environment:

```sh
python3 -m pip install -e '.[test]'
python3 -m image_browser "/path/to/images"
```

Browser assets need no build. Run the backend, frontend, and packaging tests:

```sh
python3 -B -m unittest discover -s tests/backend
npm test
python3 -B -m unittest discover -s tests/package
```

Browser smoke and performance checks require Chrome/Chromium and Node 22+:

```sh
python3 -B tests/browser/smoke.py --performance
```

Container checks require a running Docker engine:

```sh
docker build -t imgbrowse:test .
python3 -B tests/container/smoke.py
```
