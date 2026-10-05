"""Package boundaries keep runtime and domain code independent of HTTP composition."""

import ast
import unittest
from importlib.util import resolve_name
from pathlib import Path


class PackageBoundaryTests(unittest.TestCase):
    def test_runtime_imports_only_runtime_and_external_modules(self):
        self.check_imports('runtime', ('image_browser.app', 'image_browser.catalog',
                                      'image_browser.storage', 'image_browser.media', 'image_browser.http'))

    def test_domain_and_storage_do_not_import_http_or_application_composition(self):
        for package in ('catalog', 'storage', 'media'):
            with self.subTest(package=package):
                self.check_imports(package, ('image_browser.app', 'image_browser.http'))

    def check_imports(self, package, forbidden):
        root = Path(__file__).resolve().parents[2] / 'image_browser' / package
        for path in root.rglob('*.py'):
            owner = '.'.join(('image_browser', *path.parent.relative_to(root.parent).parts))
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ImportFrom):
                    module = resolve_name('.' * node.level + (node.module or ''), owner)
                    modules = [module, *(module + '.' + alias.name for alias in node.names)]
                elif isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                else:
                    modules = []
                for module in modules:
                    self.assertFalse(any(module == name or module.startswith(name + '.') for name in forbidden),
                                     f'{path.name} crosses its package boundary through {module}')
