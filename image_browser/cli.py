"""Browse local images and videos without building a collection-wide index."""

import argparse
from pathlib import Path

from .server import GalleryServer


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', default='.', help='root directory (default: current directory)')
    parser.add_argument('--port', type=int, default=8080, help='HTTP port (default: 8080)')
    parser.add_argument('--host', default='127.0.0.1',
                        help='bind address (default: 127.0.0.1); use 0.0.0.0 to share on the LAN')
    args = parser.parse_args(argv)
    root = Path(args.directory).expanduser().resolve()
    if not 1 <= args.port <= 65535 or not root.is_dir():
        parser.error('provide a valid port (1–65535) and an existing directory')
    try:
        with GalleryServer((args.host, args.port), root) as server:
            local = '127.0.0.1' if args.host == '0.0.0.0' else args.host
            print(f'Serving {root} at http://{local}:{server.server_port}/', flush=True)
            if args.host == '0.0.0.0':
                print(f'LAN: http://<this-computer-IP>:{server.server_port}/ (selected folder is shared)', flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        print()
    except OSError as error:
        parser.exit(1, f'Unable to start server: {error}\n')
