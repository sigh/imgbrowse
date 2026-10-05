"""Optional smoke test of a built image with a numeric user and read-only mounts."""

import argparse
import io
import json
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from PIL import Image

REPO = Path(__file__).resolve().parents[2]


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def make_collection(root):
    root.mkdir()
    root.chmod(0o755)
    Image.new('RGB', (40, 60), 'blue').save(root / 'page.jpg')
    shutil.copyfile(REPO / 'tests/fixtures/sample.webm', root / 'video.webm')
    for name in ('@eaDir', '#recycle'):
        (root / name).mkdir()
        shutil.copyfile(root / 'page.jpg', root / name / 'hidden.jpg')
    with zipfile.ZipFile(root / 'book.cbz', 'w') as archive:
        for name in ('Chapter/page.jpg', '@eaDir/hidden.jpg', '#recycle/hidden.jpg'):
            archive.writestr(name, (root / 'page.jpg').read_bytes())
    # The fixture must be readable by a UID unrelated to the host owner.
    for file in root.rglob('*'):
        file.chmod(0o755 if file.is_dir() else 0o644)


def check(base, root):
    def get(path, headers=None):
        return urlopen(Request(base + path, headers=headers or {}), timeout=5)

    assets = ['/', '/gallery.css', '/gallery.js']
    static = REPO / 'image_browser/web/static'
    assets.extend('/static/' + file.relative_to(static).as_posix() for file in static.rglob('*.js'))
    for path in assets:
        with get(path) as response:
            assert response.status == 200 and response.read(), path
    with get('/api/folder?path=') as response:
        listing = json.load(response)
        assert listing['items'] == [{'name':'book.cbz', 'type':'folder'},
                                    {'name':'page.jpg', 'type':'image'}, {'name':'video.webm', 'type':'image'}]
    with get('/api/location?path=page.jpg') as response:
        assert json.load(response)['filesystem_path'] == str(root / 'page.jpg')
    with get('/api/metadata?path=page.jpg') as response:
        assert json.load(response)['width'] == 40
    for path in ('page.jpg', 'book.cbz/Chapter/page.jpg'):
        with get('/image?path=' + path) as response:
            assert response.read() == (root / 'page.jpg').read_bytes()
        with get('/thumbnail?path=' + path) as response, Image.open(io.BytesIO(response.read())) as thumbnail:
            assert thumbnail.format == 'JPEG'
    with get('/api/folder?path=book.cbz') as response:
        assert json.load(response)['items'] == [{'name':'Chapter', 'type':'folder'}]
    with get('/api/video?path=video.webm') as response:
        assert json.load(response)['duration'] > 0
    with get('/thumbnail?path=video.webm') as response:
        assert response.headers['X-Media-Kind'] == 'video'
        with Image.open(io.BytesIO(response.read())) as thumbnail:
            assert thumbnail.format == 'JPEG'
    with get('/image?path=video.webm', {'Range': 'bytes=0-15'}) as response:
        assert response.status == 206 and response.read() == (root / 'video.webm').read_bytes()[:16]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='imgbrowse:test', help='image already built with docker build')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve() / 'media'
        make_collection(root)
        container = docker('run', '--detach', '--rm', '--init', '--read-only', '--user', '12345:12345',
                           '--publish', '127.0.0.1::8080', '--mount', f'type=bind,src={root},dst={root},readonly',
                           args.image, str(root), '--host', '0.0.0.0', '--port', '8080',
                           '--exclude', '@eaDir', '--exclude', '#recycle')
        try:
            port = docker('port', container, '8080/tcp').rsplit(':', 1)[-1]
            base = 'http://127.0.0.1:' + port
            for attempt in range(50):
                try:
                    with urlopen(base + '/api/folder?path=', timeout=2) as response:
                        json.load(response)
                    break
                except URLError:
                    if attempt == 49:
                        raise
                    time.sleep(.1)
            check(base, root)
            print('Container smoke passed: packaged assets, exclusions, images, archives, video and filesystem paths')
        except Exception:
            subprocess.run(['docker', 'logs', container], check=False)
            raise
        finally:
            subprocess.run(['docker', 'stop', '--time', '5', container], check=False,
                           stdout=subprocess.DEVNULL, timeout=15)


if __name__ == '__main__':
    main()
