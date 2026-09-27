#!/usr/bin/env python3
"""Serve a local image gallery from a root/category/album directory tree."""

import argparse
import html
import json
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
TEMPLATE = Path(__file__).with_name("template.html")
STYLESHEET = Path(__file__).with_name("gallery.css")


def visible_directories(parent):
    """Return sorted, non-hidden directories without following symlinks."""
    return sorted(
        (entry for entry in parent.iterdir()
         if not entry.name.startswith(".") and not entry.is_symlink() and entry.is_dir()),
        key=lambda entry: entry.name.casefold(),
    )


def gather_categories(root):
    """Index images in root/category/album, retaining the existing gallery layout."""
    categories = []
    for category in visible_directories(root):
        albums = []
        for album in visible_directories(category):
            images = sorted(
                (entry.name for entry in album.iterdir()
                 if not entry.name.startswith(".") and not entry.is_symlink()
                 and entry.is_file() and entry.suffix.lower() in IMAGE_EXTENSIONS),
                key=str.casefold,
            )
            if images:
                albums.append({
                    "name": album.name,
                    "images": images,
                    "image_count": len(images),
                    "url_prefix": "/".join((quote(category.name, safe=""),
                                              quote(album.name, safe=""))) + "/",
                })
        if albums:
            categories.append({
                "name": category.name.replace("-", " ").title(),
                "directory_name": category.name,
                "albums": albums,
                "image_count": sum(album["image_count"] for album in albums),
            })
    return categories


def build_html(root):
    data = json.dumps(gather_categories(root), ensure_ascii=False).replace("<", "\\u003c")
    template = TEMPLATE.read_text(encoding="utf-8")
    title = html.escape(root.name or "Gallery", quote=True)
    return re.sub(r"__TITLE__|__GALLERY_DATA__", lambda match: {
        "__TITLE__": title, "__GALLERY_DATA__": data,
    }[match.group()], template).encode("utf-8")


class GalleryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, root, **kwargs):
        self.root = root
        super().__init__(*args, directory=str(root), **kwargs)

    def serve_request(self, head_only=False):
        path = unquote(urlsplit(self.path).path)
        if path in ("/", "/index.html"):
            self.send_content(build_html(self.root), "text/html; charset=utf-8", head_only)
            return
        if path == "/gallery.css":
            self.send_content(STYLESHEET.read_bytes(), "text/css; charset=utf-8", head_only)
            return

        parts = path.removeprefix("/").split("/")
        # Only indexed image locations are public. Reject hidden paths and symlinks.
        if (len(parts) != 3 or any(part in ("", ".", "..") or part.startswith(".") for part in parts)
                or Path(parts[-1]).suffix.lower() not in IMAGE_EXTENSIONS):
            self.send_error(404)
            return
        candidate = self.root.joinpath(*parts)
        if (any(node.is_symlink() for node in (self.root / parts[0],
                                               self.root / parts[0] / parts[1], candidate))
                or not candidate.is_file()):
            self.send_error(404)
            return
        if head_only:
            super().do_HEAD()
        else:
            super().do_GET()

    def do_GET(self):
        self.serve_request()

    def do_HEAD(self):
        self.serve_request(head_only=True)

    def send_content(self, content, content_type, head_only):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        if not head_only:
            self.wfile.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port_or_root", nargs="?", default="8080", help="port or image root")
    parser.add_argument("root_directory", nargs="?", help="image root when a port is given")
    args = parser.parse_args()
    if args.port_or_root.isdecimal():
        port = int(args.port_or_root)
        root = Path(args.root_directory or ".").expanduser().resolve()
    else:
        if args.root_directory is not None:
            parser.error("specify the port before the directory")
        port = 8080
        root = Path(args.port_or_root).expanduser().resolve()
    if not 1 <= port <= 65535:
        parser.error("port must be between 1 and 65535")
    if not root.is_dir():
        parser.error(f"not a directory: {root}")

    class RootedHandler(GalleryHandler):
        def __init__(self, *handler_args, **handler_kwargs):
            super().__init__(*handler_args, root=root, **handler_kwargs)

    try:
        with ThreadingHTTPServer(("127.0.0.1", port), RootedHandler) as server:
            print(f"Serving {root} on http://127.0.0.1:{port}/")
            server.serve_forever()
    except KeyboardInterrupt:
        print()
    except OSError as exc:
        parser.exit(1, f"Unable to start server: {exc}\n")


if __name__ == "__main__":
    main()
