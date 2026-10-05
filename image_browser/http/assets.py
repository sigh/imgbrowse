"""Discover packaged browser assets at every directory depth."""

from importlib.resources import files

APP_DIRECTORY = files('image_browser').joinpath('web')


def javascript_assets(directory, prefix='static'):
    """Serve only packaged JavaScript, using its directory structure as the URL."""
    for entry in directory.iterdir():
        path = f'{prefix}/{entry.name}'
        if entry.is_dir():
            yield from javascript_assets(entry, path)
        elif entry.name.endswith('.js'):
            yield '/' + path, path


STATIC_FILES = {
    '/': 'template.html',
    '/index.html': 'template.html',
    '/favicon.svg': 'favicon.svg',
    '/gallery.css': 'gallery.css',
    '/gallery.js': 'gallery.js',
    **dict(javascript_assets(APP_DIRECTORY.joinpath('static'))),
}
