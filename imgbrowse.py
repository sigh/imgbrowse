#!/usr/bin/env python3
"""Browse a directory of images without building a collection-wide index."""

import argparse
from pathlib import Path

from image_browser.server import GalleryServer


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
