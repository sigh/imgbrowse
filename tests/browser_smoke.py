"""Optional Chrome + Node 22+ smoke test against a temporary image collection."""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw
from PIL.ExifTags import Base, GPS, IFD

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
        'Album/Chapter 2/deep/page1.jpg', 'Odd & #/a ?#%.jpg', 'Single/only.jpg',
    ]
    for name in paths:
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        tall = name.startswith('Album/')
        image = Image.new('RGB', (1000, 1800) if tall else (320, 240), '#faf5e9' if tall else 'steelblue')
        draw = ImageDraw.Draw(image)
        draw.text((12, 12), name, fill='black')
        if tall:
            for panel in range(5):
                y = 80 + panel * 330
                draw.rectangle((40, y, 960, y + 290), outline='black', width=4)
                draw.ellipse((90, y + 30, 280, y + 250), fill='#647b83')
                draw.text((340, y + 80), f'Panel {panel + 1}: sample reading text', fill='black')
        if name == 'Album/Chapter 1/page2.jpg':
            exif = Image.Exif()
            exif[IFD.Exif] = {Base.DateTimeOriginal: '2024:03:14 12:30:00', Base.OffsetTimeOriginal: '+05:30'}
            exif[IFD.GPSInfo] = {GPS.GPSLatitudeRef: 'S', GPS.GPSLatitude: (33, 51, 36),
                                 GPS.GPSLongitudeRef: 'E', GPS.GPSLongitude: (151, 12, 0)}
            image.save(file, exif=exif)
        else:
            image.save(file)
    # Deliberately oppose name order, with nanoseconds preserved by filesystem sorting.
    for name, modified in [('Album/Chapter 1/page2.jpg', 1_700_000_000_000_000_002),
                           ('Album/Chapter 1/page10.jpg', 1_700_000_000_000_000_001),
                           ('Album/Chapter 1', 1_700_000_000_000_000_002),
                           ('Album/Chapter 2', 1_700_000_000_000_000_001)]:
        os.utime(root / name, ns=(modified, modified))
    with zipfile.ZipFile(root / 'Packed.cbz', 'w') as archive:
        for name in ('page10.jpg', 'page2.jpg', 'Chapter 3/page1.jpg'):
            archive.writestr(name, (root / 'root2.jpg').read_bytes())
        archive.writestr('notes.txt', b'Archive notes')
        archive.writestr('clip.mp4', b'Archived video')
    other = root / 'Other files'
    other.mkdir()
    (other / 'sunrise.heic').write_bytes(b'Unsupported image')
    (other / 'notes.txt').write_text('Photo notes')
    mixed = root / 'Mixed'
    mixed.mkdir()
    shutil.copyfile(root / 'root2.jpg', mixed / '1.jpg')
    shutil.copyfile(Path(__file__).parent / 'fixtures' / 'sample.webm', mixed / '2.webm')
    shutil.copyfile(root / 'root2.jpg', mixed / '3.jpg')
    (mixed / '4.mp4').write_bytes(b'unsupported video')
    (root / 'Empty').mkdir()
    long_name = 'A very long collection title with many descriptive words and publisher details ' * 2
    long_folder = root / 'Names' / (long_name + '- Chapter 123')
    long_folder.mkdir(parents=True)
    shutil.copyfile(root / 'root2.jpg', long_folder / 'Harbour at sunrise — edited photograph from the autumn coastal collection.jpg')


def check_http(base):
    for route, content_type in [('/', 'text/html'), ('/gallery.css', 'text/css'),
                                ('/gallery.js', 'javascript'), ('/api/folder', 'application/json'),
                                ('/thumbnail?path=root2.jpg', 'image/jpeg'),
                                ('/thumbnail?path=Packed.cbz%2Fpage2.jpg', 'image/jpeg')]:
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
    parser.add_argument('--performance', action='store_true', help='also exercise bounded windows with 2,400 images')
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
            command = ['node', str(Path(__file__).with_suffix('.mjs')), debug_port, base,
                       str(args.screenshots.resolve()) if args.screenshots else '', str(root)]
            subprocess.run(command, check=True, timeout=60)
            if args.performance:
                large = root / 'Large'
                large.mkdir()
                data = (root / 'root2.jpg').read_bytes()
                for number in range(2400):
                    (large / f'page{number}.jpg').write_bytes(data)
                server.gallery.invalidate('')
                subprocess.run(['node', str(Path(__file__).with_name('browser_performance.mjs')),
                                debug_port, base], check=True, timeout=60)
        finally:
            if browser is not None:
                browser.terminate()
                browser.wait(timeout=10)
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
