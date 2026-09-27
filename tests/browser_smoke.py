"""Optional Chrome + Node 22+ smoke test against a temporary image collection."""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image

from image_browser.server import GalleryHandler, GalleryServer


def chrome_executable():
    configured = os.environ.get('CHROME_BIN')
    candidates = [configured, shutil.which('google-chrome'), shutil.which('chromium'),
                  shutil.which('chromium-browser'),
                  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise SystemExit('Install Chrome/Chromium or set CHROME_BIN to its executable.')


def make_collection(root):
    root.mkdir()
    paths = [f'root{number}.jpg' for number in range(160)] + [
        'Album/Chapter 1/page2.jpg', 'Album/Chapter 1/page10.jpg',
        'Album/Chapter 2/deep/page1.jpg', 'Odd & #/a ?#%.jpg',
    ]
    for name in paths:
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (120, 180), 'steelblue').save(file)
    (root / 'Empty').mkdir()
    long_name = 'A very long collection title with many descriptive words and publisher details ' * 2
    (root / 'Names' / (long_name + '- Chapter 123')).mkdir(parents=True)


def check_http(base):
    for route, content_type in [('/', 'text/html'), ('/gallery.css', 'text/css'),
                                ('/gallery.js', 'javascript'), ('/api/folder', 'application/json'),
                                ('/thumbnail?path=root2.jpg', 'image/jpeg')]:
        with urlopen(base + route) as response:
            assert content_type in response.headers['Content-Type']
            if route.startswith('/thumbnail'):
                etag = response.headers['ETag']
                try:
                    urlopen(Request(base + route, headers={'If-None-Match': etag}))
                except HTTPError as error:
                    assert error.code == 304
                else:
                    raise AssertionError('Thumbnail should be revalidated without a body')
    with urlopen(Request(base + '/image?path=root2.jpg', method='HEAD')) as response:
        assert not response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots', type=Path, help='optional screenshot output directory')
    args = parser.parse_args()
    chrome = chrome_executable()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    GalleryHandler.log_message = lambda self, format, *args: None
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / 'images'
        make_collection(root)
        server = GalleryServer(('127.0.0.1', 0), root)
        Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{server.server_port}'
        browser = None
        try:
            profile = Path(directory) / 'chrome'
            browser = subprocess.Popen([
                chrome, '--headless=new', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-background-networking',
                '--remote-debugging-port=0', f'--user-data-dir={profile}', 'about:blank',
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            port_file = profile / 'DevToolsActivePort'
            for _ in range(100):
                if port_file.exists():
                    break
                time.sleep(.1)
            debug_port = port_file.read_text().splitlines()[0]
            check_http(base)
            command = ['node', str(Path(__file__).with_suffix('.mjs')), debug_port, base]
            if args.screenshots:
                command.append(str(args.screenshots.resolve()))
            subprocess.run(command, check=True, timeout=60)
        finally:
            if browser is not None:
                browser.terminate()
                browser.wait(timeout=10)
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
