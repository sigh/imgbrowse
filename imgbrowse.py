#!/usr/bin/env python3
"""Browse a directory of images without building a collection-wide index."""

import argparse
from bisect import bisect_left, bisect_right
from collections import OrderedDict
import io
import json
import mimetypes
import os
import re
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageOps

APP_DIRECTORY = Path(__file__).parent
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
STATIC_FILES = {'/': 'template.html', '/index.html': 'template.html',
                '/gallery.css': 'gallery.css', '/gallery.js': 'gallery.js'}
DIRECTORY_WORK = threading.BoundedSemaphore(8)
THUMBNAIL_WORK = threading.BoundedSemaphore(4)
THUMBNAIL_CACHE_BYTES = 64 * 1024 * 1024
WALK_BUDGET = 24
PAGE_SIZE = 60


def natural_key(name):
    parts = tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                  for part in re.split(r'(\d+)', name))
    return parts, name


class Gallery:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.thumbnails = OrderedDict()
        self.thumbnail_bytes = 0
        self.thumbnail_lock = threading.Lock()

    def thumbnail(self, file, stat):
        """Reuse encoded thumbnails in a bounded, modification-aware memory cache."""
        key = (str(file), stat.st_mtime_ns, stat.st_size)
        def cached():
            with self.thumbnail_lock:
                data = self.thumbnails.get(key)
                if data is not None:
                    self.thumbnails.move_to_end(key)
                return data

        data = cached()
        if data is not None:
            return data
        with THUMBNAIL_WORK:
            data = cached()
            if data is not None:
                return data
            with Image.open(file) as image:
                image.draft('RGB', (400, 400))
                # Resize before EXIF transposition, avoiding a full-size pixel copy.
                image.thumbnail((400, 400))
                image = ImageOps.exif_transpose(image)
                image.thumbnail((400, 300))
                output = io.BytesIO()
                image.convert('RGB').save(output, 'JPEG', quality=78)
                data = output.getvalue()
            with self.thumbnail_lock:
                if key not in self.thumbnails and len(data) <= THUMBNAIL_CACHE_BYTES:
                    self.thumbnails[key] = data
                    self.thumbnail_bytes += len(data)
                    while self.thumbnail_bytes > THUMBNAIL_CACHE_BYTES:
                        _, evicted = self.thumbnails.popitem(last=False)
                        self.thumbnail_bytes -= len(evicted)
            return data

    def resolve(self, relative):
        if not isinstance(relative, str) or '\x00' in relative:
            raise ValueError('Invalid path')
        path = PurePosixPath(relative)
        if path.is_absolute() or any(part.startswith('.') for part in path.parts):
            raise ValueError('Path is outside the visible collection')
        candidate = self.root
        for part in path.parts:
            candidate = candidate / part
            if candidate.is_symlink():
                raise ValueError('Symbolic links are not included')
        return candidate

    def listing(self, relative):
        directory = self.resolve(relative)
        folders, images = [], []
        with DIRECTORY_WORK, os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.startswith('.') or entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    folders.append(entry.name)
                elif Path(entry.name).suffix.lower() in IMAGE_EXTENSIONS and entry.is_file(follow_symlinks=False):
                    images.append(entry.name)
        return {'folders': sorted(folders, key=natural_key),
                'images': sorted(images, key=natural_key)}

    def preview(self, relative):
        """Follow one branch only; return a continuation after bounded work."""
        for _ in range(WALK_BUDGET):
            listing = self.listing(relative)
            if listing['images']:
                return {'image': str(PurePosixPath(relative) / listing['images'][0])}
            if not listing['folders']:
                return {'image': None}
            relative = str(PurePosixPath(relative) / listing['folders'][0])
        return {'image': None, 'continue': relative}

    def walk(self, root='', anchor=None, reverse=False, cursor=None, limit=PAGE_SIZE):
        """Page through a depth-first sequence; each request visits bounded folders.

        An anchor seeds the stack from its ancestors, so opening a deep image
        never requires enumerating the earlier portion of the collection.
        Cursors hold names rather than array offsets and contain no server state.
        """
        root_path = PurePosixPath(root)
        self.resolve(root)
        phases = ['folders', 'images'] if reverse else ['images', 'folders']
        if cursor is None:
            stack = [{'path': root, 'phase': 0, 'after': None}]
            if anchor:
                self.resolve(anchor)
                relative = PurePosixPath(anchor).relative_to(root_path)
                stack = []
                parent = root_path
                for name in relative.parts[:-1]:
                    stack.append({'path': str(parent) if str(parent) != '.' else '',
                                  'phase': phases.index('folders'), 'after': name})
                    parent /= name
                stack.append({'path': str(parent) if str(parent) != '.' else '',
                              'phase': phases.index('images'), 'after': relative.name})
        else:
            if not isinstance(cursor, list) or len(cursor) > 512:
                raise ValueError('Invalid continuation')
            stack = [dict(frame) for frame in cursor]
            for frame in stack:
                self.resolve(frame['path'])
                PurePosixPath(frame['path']).relative_to(root_path)
                if frame['phase'] not in (0, 1, 2) or not isinstance(frame.get('after'), (str, type(None))):
                    raise ValueError('Invalid continuation')
        items, warnings, listings, keys = [], [], {}, {}
        while stack and len(items) < limit:
            frame = stack[-1]
            path = frame['path']
            if frame['phase'] >= 2:
                stack.pop()
                continue
            if path not in listings:
                if len(listings) >= WALK_BUDGET:
                    break
                try:
                    listings[path] = self.listing(path)
                except OSError as error:
                    listings[path] = {'folders': [], 'images': []}
                    warnings.append({'path': path, 'message': str(error)})
            phase = phases[frame['phase']]
            names = listings[path][phase]
            if (path, phase) not in keys:
                keys[path, phase] = [natural_key(name) for name in names]
            after = frame['after']
            if reverse:
                index = len(names) - 1 if after is None else bisect_left(keys[path, phase], natural_key(after)) - 1
            else:
                index = 0 if after is None else bisect_right(keys[path, phase], natural_key(after))
            if not 0 <= index < len(names):
                frame['phase'] += 1
                frame['after'] = None
                continue
            name = names[index]
            frame['after'] = name
            child = str(PurePosixPath(path) / name)
            if phase == 'images':
                items.append(child)
            else:
                stack.append({'path': child, 'phase': 0, 'after': None})
        return {'images': items, 'cursor': stack or None, 'warnings': warnings}


class GalleryHandler(BaseHTTPRequestHandler):
    def send_content(self, data, content_type, status=200):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_json(self, value, status=200):
        self.send_content(json.dumps(value).encode(), 'application/json; charset=utf-8', status)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            url = urlsplit(self.path)
            query = parse_qs(url.query, keep_blank_values=True)
            path = query.get('path', [''])[0]
            gallery = self.server.gallery
            if url.path in STATIC_FILES:
                file = APP_DIRECTORY / STATIC_FILES[url.path]
                content_type = mimetypes.guess_type(file.name)[0] or 'text/plain'
                self.send_content(file.read_bytes(), content_type + '; charset=utf-8')
            elif url.path == '/api/folder':
                self.send_json({'path': path, 'root_name': gallery.root.name,
                                **gallery.listing(path)})
            elif url.path == '/api/preview':
                self.send_json(gallery.preview(path))
            elif url.path in ('/image', '/thumbnail'):
                file = gallery.resolve(path)
                if file.suffix.lower() not in IMAGE_EXTENSIONS:
                    raise FileNotFoundError('Unsupported image')
                stat = file.stat()
                etag = f'"{stat.st_mtime_ns}-{stat.st_size}"'
                if self.headers.get('If-None-Match') == etag:
                    self.send_response(304)
                    self.send_header('ETag', etag)
                    self.end_headers()
                    return
                if url.path == '/thumbnail':
                    data = gallery.thumbnail(file, stat)
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('ETag', etag)
                    self.send_header('Cache-Control', 'no-cache')
                    self.end_headers()
                    if self.command != 'HEAD':
                        self.wfile.write(data)
                else:
                    with file.open('rb') as source:
                        self.send_response(200)
                        self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
                        self.send_header('Content-Length', str(stat.st_size))
                        self.send_header('ETag', etag)
                        self.send_header('Cache-Control', 'no-cache')
                        self.end_headers()
                        if self.command != 'HEAD':
                            shutil.copyfileobj(source, self.wfile)
            else:
                self.send_json({'error': 'Not found'}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, OSError, Image.DecompressionBombError) as error:
            self.send_json({'error': str(error)}, 400 if isinstance(error, ValueError) else 404)

    def do_POST(self):
        try:
            if urlsplit(self.path).path != '/api/walk':
                self.send_json({'error': 'Not found'}, 404)
                return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 131072:
                raise ValueError('Invalid request size')
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError('Expected a JSON object')
            limit = request.get('limit', PAGE_SIZE)
            if type(limit) is not int or not 1 <= limit <= PAGE_SIZE:
                raise ValueError('Invalid page size')
            result = self.server.gallery.walk(
                root=request.get('root', ''), anchor=request.get('anchor'),
                reverse=bool(request.get('reverse')), cursor=request.get('cursor'), limit=limit)
            self.send_json(result)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, OSError, KeyError, TypeError) as error:
            self.send_json({'error': str(error)}, 400)


class GalleryServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root):
        self.gallery = Gallery(root)
        super().__init__(address, GalleryHandler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('port_or_root', nargs='?', default='8080', help='port or image root')
    parser.add_argument('root_directory', nargs='?', help='image root when a port is given')
    args = parser.parse_args()
    if args.port_or_root.isdecimal():
        port = int(args.port_or_root)
        root = Path(args.root_directory or '.').expanduser().resolve()
    else:
        if args.root_directory is not None:
            parser.error('specify the port before the directory')
        port, root = 8080, Path(args.port_or_root).expanduser().resolve()
    if not 1 <= port <= 65535 or not root.is_dir():
        parser.error('provide a valid port (1–65535) and an existing directory')
    try:
        with GalleryServer(('127.0.0.1', port), root) as server:
            print(f'Serving {root} on http://127.0.0.1:{port}/', flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        print()
    except OSError as error:
        parser.exit(1, f'Unable to start server: {error}\n')


if __name__ == '__main__':
    main()
