"""Build an sdist and install its wheel outside the checkout, without runtime network access."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import venv
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class InstalledWheelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        source = cls.root / 'source'
        source.mkdir()
        for name in ('pyproject.toml', 'MANIFEST.in', 'README.md', 'LICENSE'):
            shutil.copyfile(REPO / name, source / name)
        shutil.copytree(REPO / 'image_browser', source / 'image_browser',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        # An extra directory depth guards against the original shallow data glob.
        probe = source / 'image_browser/web/static/package-probe/nested/probe.js'
        probe.parent.mkdir(parents=True)
        probe.write_text('export const packaged = true;\n')
        cls.modules = {path.relative_to(source).as_posix() for path in (source / 'image_browser').rglob('*.py')}
        cls.assets = {path.relative_to(source).as_posix() for path in (source / 'image_browser/web').rglob('*') if path.is_file()}
        cls.run_command([sys.executable, '-B', '-m', 'build', '--no-isolation', str(source)], cls.root)
        # build's default workflow rebuilds the wheel from the generated sdist.
        cls.wheel = next((source / 'dist').glob('*.whl'))
        cls.environment = cls.root / 'environment'
        venv.EnvBuilder(with_pip=True, system_site_packages=True).create(cls.environment)
        cls.python = cls.environment / 'bin/python'
        cls.run_command([str(cls.python), '-m', 'pip', 'install', '--ignore-installed', '--no-deps', '--no-index', str(cls.wheel)], cls.root)
        cls.outside = cls.root / 'outside'
        cls.outside.mkdir()
        cls.runtime_env = {key:value for key, value in os.environ.items() if key != 'PYTHONPATH'}

    @classmethod
    def run_command(cls, command, cwd, env=None):
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=60, check=False)
        if result.returncode:
            raise AssertionError(f'{command!r} failed:\n{result.stdout}\n{result.stderr}')
        return result.stdout

    def test_wheel_contains_all_modules_and_recursive_assets(self):
        with zipfile.ZipFile(self.wheel) as wheel:
            names = set(wheel.namelist())
        self.assertLessEqual(self.modules | self.assets, names)
        self.assertFalse(any(name.startswith('tests/') or '__pycache__' in name for name in names))

    def test_installed_entrypoints_run_outside_the_checkout(self):
        for command in ([str(self.python), '-I', '-m', 'image_browser', '--help'],
                        [str(self.environment / 'bin/imgbrowse'), '--help']):
            with self.subTest(command=command):
                output = self.run_command(command, self.outside, self.runtime_env)
                self.assertIn('--exclude', output)
                self.assertIn('--port', output)

    def test_installed_server_serves_every_asset_and_typed_catalog_contract(self):
        script = '''
import importlib
import json
import pathlib
import pkgutil
import threading
import urllib.request
import image_browser
from image_browser.http.server import GalleryHandler, GalleryServer
from image_browser.http.assets import APP_DIRECTORY, STATIC_FILES

for module in pkgutil.walk_packages(image_browser.__path__, image_browser.__name__ + '.'):
    importlib.import_module(module.name)
GalleryHandler.log_message = lambda *args: None
collection = pathlib.Path('collection')
collection.mkdir()
(collection / 'a.jpg').write_bytes(b'fixture')
with GalleryServer(('127.0.0.1', 0), collection) as server:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:' + str(server.server_port)
    try:
        assert '/static/package-probe/nested/probe.js' in STATIC_FILES
        for route, asset in STATIC_FILES.items():
            with urllib.request.urlopen(base + route) as response:
                assert response.read() == APP_DIRECTORY.joinpath(asset).read_bytes(), route
        with urllib.request.urlopen(base + '/api/folder') as response:
            listing = json.load(response)
            assert listing['items'] == [{'name':'a.jpg', 'type':'image'}]
        data = json.dumps({'items':listing['items'], 'revision':listing['revision']}).encode()
        request = urllib.request.Request(base + '/api/folder/entries', data=data,
                                         headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            assert json.load(response)['entries'][0]['status'] == 'ready'
    finally:
        server.shutdown()
print(json.dumps({'package':image_browser.__file__, 'assets':len(STATIC_FILES)}))
'''
        output = self.run_command([str(self.python), '-I', '-c', script], self.outside, self.runtime_env)
        report = json.loads(output)
        self.assertTrue(Path(report['package']).resolve().is_relative_to(self.environment.resolve()), report)
        self.assertGreater(report['assets'], 32)
