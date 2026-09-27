"""HTTP routes for the browser shell, filesystem API, and image responses."""

import json
import mimetypes
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from PIL import Image

from .catalog import IMAGE_EXTENSIONS, PAGE_SIZE, Gallery
from .thumbnails import ThumbnailCache

APP_DIRECTORY = Path(__file__).resolve().parent.parent
MAX_REQUEST_BYTES = 128 * 1024
STATIC_FILES = {
    '/': 'template.html',
    '/index.html': 'template.html',
    '/gallery.css': 'gallery.css',
    '/gallery.js': 'gallery.js',
    **{f'/static/{name}.js': f'static/{name}.js' for name in (
        'api', 'dom', 'state', 'preview-loader', 'grid-layout', 'folder-grid', 'image-viewer',
        'viewer-viewport', 'wheel-gesture', 'icons', 'thumbnail-strip',
    )},
}


class GalleryHandler(BaseHTTPRequestHandler):
    def __init__(self, request, client_address, server: 'GalleryServer'):
        self.gallery = server.gallery
        self.thumbnails = server.thumbnails
        super().__init__(request, client_address, server)

    def send_headers(self, content_type, length, status=200, etag=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-cache')
        if etag is not None:
            self.send_header('ETag', etag)
        self.end_headers()

    def send_content(self, data, content_type, status=200, etag=None):
        self.send_headers(content_type, len(data), status, etag)
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_json(self, value, status=200):
        self.send_content(json.dumps(value).encode(), 'application/json; charset=utf-8', status)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._dispatch(self._get)

    def do_POST(self):
        self._dispatch(self._post)

    def _dispatch(self, route):
        try:
            route()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Navigating away cancels in-flight requests.
        except (ValueError, OSError, Image.DecompressionBombError) as error:
            status = 400 if isinstance(error, ValueError) or self.command == 'POST' else 404
            try:
                self.send_json({'error': str(error)}, status)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _get(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        path = query.get('path', [''])[0]
        gallery = self.gallery
        if url.path in STATIC_FILES:
            file = APP_DIRECTORY / STATIC_FILES[url.path]
            content_type = mimetypes.guess_type(file.name)[0] or 'text/plain'
            self.send_content(file.read_bytes(), content_type + '; charset=utf-8')
        elif url.path == '/api/folder':
            self.send_json({'path': path, 'root_name': gallery.root.name, **gallery.listing(path)})
        elif url.path == '/api/preview':
            self.send_json(gallery.preview(path))
        elif url.path in ('/image', '/thumbnail'):
            self._serve_image(path, thumbnail=url.path == '/thumbnail')
        else:
            self.send_json({'error': 'Not found'}, 404)

    def _serve_image(self, path, thumbnail=False):
        file = self.gallery.resolve(path)
        if file.suffix.lower() not in IMAGE_EXTENSIONS:
            raise FileNotFoundError('Unsupported image')
        stat = file.stat()
        etag = f'"{stat.st_mtime_ns}-{stat.st_size}"'
        if self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.end_headers()
            return
        if thumbnail:
            data = self.thumbnails.get(file, stat)
            self.send_content(data, 'image/jpeg', etag=etag)
            return
        content_type = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        with file.open('rb') as source:
            self.send_headers(content_type, stat.st_size, etag=etag)
            if self.command != 'HEAD':
                shutil.copyfileobj(source, self.wfile)

    def _read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_REQUEST_BYTES:
            raise ValueError('Invalid request size')
        request = json.loads(self.rfile.read(length))
        if not isinstance(request, dict):
            # Invalid JSON values use the same HTTP 400 path as malformed JSON.
            raise ValueError('Expected a JSON object')  # noqa: TRY004
        return request

    def _post(self):
        if urlsplit(self.path).path != '/api/walk':
            self.send_json({'error': 'Not found'}, 404)
            return
        request = self._read_json()
        result = self.gallery.walk(
            root=request.get('root', ''),
            anchor=request.get('anchor'),
            reverse=request.get('reverse', False),
            cursor=request.get('cursor'),
            limit=request.get('limit', PAGE_SIZE),
        )
        self.send_json(result)


class GalleryServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root):
        self.gallery = Gallery(root)
        self.thumbnails = ThumbnailCache()
        super().__init__(address, GalleryHandler)
