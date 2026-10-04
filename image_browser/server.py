"""HTTP routes for the browser shell, filesystem API, and image responses."""

import json
import mimetypes
import select
import socket
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import parse_qs, urlsplit

from PIL import Image

from .catalog import PAGE_SIZE, Gallery
from .metadata import metadata
from .ordering import Ordering
from .previews import PreviewService
from .ranges import UnsatisfiableRange, byte_range
from .sources import VIDEO_TYPES
from .thumbnails import ThumbnailCache
from .work import Busy, Cancelled, Invalidated, WorkGate, check_cancelled, request_work

APP_DIRECTORY = files('image_browser').joinpath('web')
MAX_REQUEST_BYTES = 128 * 1024
STATIC_FILES = {
    '/': 'template.html',
    '/index.html': 'template.html',
    '/favicon.svg': 'favicon.svg',
    '/gallery.css': 'gallery.css',
    '/gallery.js': 'gallery.js',
    **{f'/static/{name}.js': f'static/{name}.js' for name in (
        'api', 'dom', 'state', 'preview-loader', 'grid-layout', 'folder-grid', 'folder-tree', 'image-viewer',
        'viewer-viewport', 'continuous-reader', 'collection-window', 'wheel-gesture', 'icons', 'thumbnail-strip',
        'resource-cache', 'sequence', 'media-cache', 'folder-path', 'breadcrumbs', 'item-header',
        'video-player', 'media-kind', 'metadata', 'metadata-data', 'sort-controls',
    )},
}


class GalleryHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def __init__(self, request, client_address, server: 'GalleryServer'):
        self.gallery_server = server
        self.gallery = server.gallery
        self.thumbnails = server.thumbnails
        super().__init__(request, client_address, server)

    def send_headers(self, content_type, length, status=200, etag=None, extra=None):
        self.response_started = True
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        if status not in (204, 304):
            self.send_header('Content-Length', str(length))
        media = urlsplit(self.path).path in ('/image', '/thumbnail')
        self.send_header('Cache-Control', 'no-store' if status >= 400 else
                         'private, max-age=300' if media and status != 204 else 'no-cache')
        if etag is not None:
            self.send_header('ETag', etag)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()

    def send_content(self, data, content_type, status=200, etag=None):
        self.send_headers(content_type, len(data), status, etag)
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_json(self, value, status=200):
        self.send_content(json.dumps(value).encode(), 'application/json; charset=utf-8', status)

    def matches_etag(self, etag):
        candidates = [value.strip().removeprefix('W/') for value in
                      self.headers.get('If-None-Match', '').split(',')]
        return '*' in candidates or (etag is not None and etag.removeprefix('W/') in candidates)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._dispatch(self._get)

    def do_POST(self):
        self._dispatch(self._post)

    def _dispatch(self, route):
        self.response_started = False
        try:
            url = urlsplit(self.path)
            priority = 0 if url.path == '/image' else 2 if url.path in ('/thumbnail', '/api/video') else 1
            if parse_qs(url.query).get('prefetch') == ['1']:
                priority = 3
            with request_work(priority, self.disconnected):
                route()
        except (Cancelled, BrokenPipeError, ConnectionResetError):
            pass  # Navigating away cancels in-flight requests.
        except (ValueError, OSError, RuntimeError, zipfile.BadZipFile, Image.DecompressionBombError) as error:
            if self.response_started:
                self.close_connection = True
                return
            status = 400 if isinstance(error, ValueError) or self.command == 'POST' else 404
            try:
                self.send_json({'error': str(error)}, status)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def disconnected(self):
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if not readable:
                return False
            return self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b''
        except BlockingIOError:
            return False
        except (OSError, ValueError):
            return True

    def _get(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        path = query.get('path', [''])[0]
        gallery = self.gallery
        if url.path in STATIC_FILES:
            file = APP_DIRECTORY.joinpath(STATIC_FILES[url.path])
            content_type = mimetypes.guess_type(file.name)[0] or 'text/plain'
            self.send_content(file.read_bytes(), content_type + '; charset=utf-8')
        elif url.path == '/api/info':
            self.send_json({'root_name': gallery.root.name})
        elif url.path == '/api/video':
            source = gallery.source(path)
            if source.kind != 'video':
                raise ValueError('Not a video')
            self.send_json(self.thumbnails.video_info(source))
        elif url.path == '/api/location':
            self.send_json(gallery.location(path))
        elif url.path == '/api/metadata':
            self.send_json(metadata(gallery, path, self.gallery_server.image_work,
                                    self.gallery_server.archive_work))
        elif url.path == '/api/folder':
            ordering = Ordering.from_params({name: values[0] for name, values in query.items()})
            self.send_json({'path': path, 'root_name': gallery.root.name,
                            **gallery.listing(path, ordering=ordering),
                            'natural_folders': gallery.snapshot(path)['listing']['folders']})
        elif url.path == '/thumbnail':
            self._serve_thumbnail(path)
        elif url.path == '/image':
            self._serve_image(path)
        else:
            self.send_json({'error': 'Not found'}, 404)

    def _serve_thumbnail(self, path):
        service = self.gallery_server.previews
        preview = None
        try:
            # Input errors are distinct from a valid source that cannot be decoded.
            try:
                self.gallery.validate(path)
            except ValueError as error:
                self.send_json({'error': str(error)}, 400)
                return
            preview = service.prepare(path)
            if preview.source is None:
                self.send_headers('image/jpeg', 0, 204)
                return
            metadata = service.metadata(preview)
            headers = {'X-Media-Kind': metadata['media_kind']}
            if metadata['duration'] is not None:
                headers['X-Video-Duration'] = str(metadata['duration'])
            if self.matches_etag(preview.etag):
                service.check(preview)
                self.send_headers('image/jpeg', 0, 304, preview.etag, headers)
                return
            data = service.render(preview)
            self.send_headers('image/jpeg', len(data), etag=preview.etag, extra=headers)
            if self.command != 'HEAD':
                self.wfile.write(data)
        except (Cancelled, BrokenPipeError, ConnectionResetError):
            raise
        except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, Image.DecompressionBombError) as error:
            if self.response_started:
                raise
            status = (503 if isinstance(error, (Busy, Invalidated)) else
                      403 if isinstance(error, PermissionError) else
                      404 if isinstance(error, (FileNotFoundError, NotADirectoryError)) else
                      422 if isinstance(error, (ValueError, zipfile.BadZipFile, Image.UnidentifiedImageError,
                                               Image.DecompressionBombError)) else 500)
            body = {'error': str(error)}
            if preview and preview.source:
                body['media_kind'] = preview.source.kind
                if preview.source.kind == 'video' and isinstance(error, ValueError):
                    body['code'] = 'video_preview_unavailable'
            self.send_json(body, status)

    def _serve_image(self, path):
        source = self.gallery.source(path)
        if source.kind == 'video':
            self._serve_video(path, source)
            return
        file, member, stat = source.file, source.member, source.stat
        etag = source.etag
        content_type = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if self.matches_etag(etag):
            self.send_headers(content_type, 0, 304, etag)
            return
        if member is not None:
            if self.command == 'HEAD':
                self.send_headers(content_type, member.file_size, etag=etag)
            else:
                with self.gallery_server.archive_work:
                    archive = self.gallery.archives.get(file, stat)
                    with archive.open(member) as stream:
                        self.send_headers(content_type, source.size, etag=etag)
                        self.copy_image(stream)
            return
        with self.gallery_server.image_work, self.gallery.resolve(path).open('rb') as stream:
            self.send_headers(content_type, source.size, etag=etag)
            if self.command != 'HEAD':
                self.copy_image(stream)

    def _serve_video(self, path, source):
        content_type = VIDEO_TYPES[source.file.suffix.lower()]
        headers = {'Accept-Ranges': 'bytes'}
        if self.matches_etag(source.etag):
            self.send_headers(content_type, 0, 304, source.etag, headers)
            return
        selected = None
        if self.command == 'GET' and self.headers.get('If-Range', source.etag) == source.etag:
            try:
                selected = byte_range(self.headers.get('Range'), source.size)
            except UnsatisfiableRange:
                headers['Content-Range'] = f'bytes */{source.size}'
                self.send_headers(content_type, 0, 416, source.etag, headers)
                return
        start, end = selected if selected else (0, source.size - 1)
        length = end - start + 1
        if selected:
            headers['Content-Range'] = f'bytes {start}-{end}/{source.size}'
        with self.gallery_server.video_work, self.gallery.resolve(path).open('rb') as stream:
            stream.seek(start)
            self.send_headers(content_type, length, 206 if selected else 200, source.etag, headers)
            if self.command != 'HEAD':
                self.copy_image(stream, length)

    def copy_image(self, source, remaining=None):
        while remaining is None or remaining > 0:
            check_cancelled()
            chunk = source.read(min(256 * 1024, remaining) if remaining is not None else 256 * 1024)
            if not chunk:
                break
            self.wfile.write(chunk)
            if remaining is not None:
                remaining -= len(chunk)

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
        path = urlsplit(self.path).path
        if path == '/api/refresh':
            request = self._read_json()
            self.gallery.invalidate(request.get('path', ''))
            self.thumbnails.invalidate()
            self.send_json({'generation': self.gallery.generation})
            return
        if path != '/api/walk':
            self.send_json({'error': 'Not found'}, 404)
            return
        request = self._read_json()
        result = self.gallery.walk(
            root=request.get('root', ''),
            anchor=request.get('anchor'),
            reverse=request.get('reverse', False),
            cursor=request.get('cursor'),
            ordering=Ordering.from_params(request),
            limit=request.get('limit', PAGE_SIZE),
        )
        self.send_json(result)


class GalleryServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, root, exclude=()):
        self.gallery = Gallery(root, exclude)
        self.thumbnails = ThumbnailCache()
        self.archive_work = WorkGate(2, 1)
        self.previews = PreviewService(self.gallery, self.thumbnails, self.archive_work)
        self.image_work = WorkGate(4, 1)
        self.video_work = WorkGate(2, 1)
        super().__init__(address, GalleryHandler)
