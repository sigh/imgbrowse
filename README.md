# imgbrowse

A small local gallery for browsing image collections in a web browser. Requires Python 3.9 or newer; no third-party packages are needed.

## Run

```sh
python3 imgbrowse.py [port] [directory]
```

The port defaults to `8080`; the directory defaults to the current directory. For example, `python3 imgbrowse.py 8080 ~/Pictures` serves the gallery at `http://127.0.0.1:8080/`. Stop it with Ctrl+C.

## Directory layout

The current layout expects **two directory levels** below the chosen root:

```text
Pictures/
  Comics/
    Volume 1/
      001.jpg
      002.jpg
  Holiday photos/
    Day 1/
      beach.png
```

The first level appears as gallery cards; the second level appears as rows of images. Empty folders and hidden files/folders are skipped. Supported extensions are JPG, JPEG, PNG, GIF, WebP, and BMP. Images are sorted by filename.

Click a card to browse its albums, then click an image to open the viewer. Arrow keys or the mouse wheel move between images; Escape closes the current view. The URL can be bookmarked to return to a card or image.

The server listens on localhost and reads the directory on each gallery page load, so refresh the page after changing files.

Gallery styles are in `gallery.css`.
