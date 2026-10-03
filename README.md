# imgbrowse

A read-only image and video browser for folder trees and ZIP/CBZ archives.
Runs on macOS and Linux with Python 3.9+ and Pillow. FFmpeg/ffprobe enable
video previews and duration labels.

## Install and run

From a checkout:

```sh
pipx install .
imgbrowse "/path/to/images"
```

Open `http://127.0.0.1:8080/`. Use `--host 0.0.0.0` to share on the LAN
without a login, and `-p PORT` to change the port. See `imgbrowse --help`.

Repeat `--exclude NAME` to omit exact, case-sensitive file or folder names
at any depth, including archive members. Hidden names and symlinks are omitted.

## Browse and read

- **Browse** shows immediate folder contents, with previews or a filtered list.
- **Overview** shows media throughout the selected folder's descendants.
- **View** opens media with sizing controls and an optional thumbnail tray.

All screens keep the same current folder. The sidebar opens a folder tree;
arrows expand branches, names navigate, and the selected name toggles its branch.
Modified clicks open links in another tab.

Use left/right arrows to turn pages and Escape to return to Browse.
Back/Forward restores browsing context; Refresh picks up disk changes.
Reading settings are remembered for the tab session.

Supports JPG, JPEG, PNG, GIF, WebP and BMP, including images inside ZIP/CBZ files.
Loose MP4, M4V, WebM, OGV and MOV videos use native browser playback, subject to
codec support. Archives are read without extraction; no persistent cache is needed.

## Container

```sh
docker build -t imgbrowse .
docker run --rm --init --read-only \
  --user "$(id -u):$(id -g)" --publish 8080:8080 \
  --mount type=bind,src=/path/to/images,dst=/media,readonly \
  imgbrowse
```

The image includes FFmpeg and serves `/media` on port 8080 as a non-root user.
The selected user needs read access to the collection.

## Development

Install with `python3 -m pip install -e .` in a virtual environment, then run
`python3 imgbrowse.py "/path/to/images"`. Browser assets need no build.

```sh
python3 -B -m unittest discover -s tests
node --test tests/*.test.js
```

Optional browser checks require Chrome/Chromium and Node 22+:
`python3 -B tests/browser_smoke.py --performance`.
Container checks require a running Docker engine:
`docker build -t imgbrowse:test . && python3 -B tests/container_smoke.py`.
