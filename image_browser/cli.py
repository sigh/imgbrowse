"""Browse local images and videos without building a collection-wide index."""

import argparse
import signal
from pathlib import Path
from stat import S_ISDIR

from .server import GalleryServer


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', default='.', help='root directory (default: current directory)')
    parser.add_argument('-p', '--port', type=int, default=8080, help='HTTP port (default: 8080)')
    parser.add_argument('--host', default='127.0.0.1',
                        help='bind address (default: 127.0.0.1); use 0.0.0.0 to share on the LAN')
    parser.add_argument('--exclude', action='append', default=[], metavar='NAME',
                        help='exclude an exact file or folder name at any depth (repeatable)')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        root = Path(args.directory).expanduser().resolve()
        root_stat = root.stat()
    except FileNotFoundError:
        parser.error(f'directory does not exist: {args.directory}')
    except OSError as error:
        parser.error(f'unable to access directory {args.directory}: {error.strerror or error}')
    if not S_ISDIR(root_stat.st_mode):
        parser.error(f'not a directory: {args.directory}')
    # Stop cleanly on SIGTERM (e.g. docker stop), as on Ctrl-C.
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        with GalleryServer((args.host, args.port), root, exclude=args.exclude) as server:
            local = '127.0.0.1' if args.host == '0.0.0.0' else args.host
            print(f'Serving {root} at http://{local}:{server.server_port}/', flush=True)
            if args.host == '0.0.0.0':
                print(f'LAN: http://<this-computer-IP>:{server.server_port}/ (selected folder is shared)', flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        print()
    except OSError as error:
        parser.exit(1, f'Unable to start server: {error}\n')
