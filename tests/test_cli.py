"""Launch defaults, LAN binding, and invalid command-line arguments."""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from image_browser.cli import main


class CliTests(unittest.TestCase):
    def test_launch_defaults_and_lan(self):
        with tempfile.TemporaryDirectory() as directory:
            for options, host, port in [([], '127.0.0.1', 8080),
                                        (['--host', '0.0.0.0', '--port', '9090'], '0.0.0.0', 9090)]:
                with patch('image_browser.cli.GalleryServer') as server, contextlib.redirect_stdout(io.StringIO()):
                    running = server.return_value.__enter__.return_value
                    running.serve_forever.side_effect = KeyboardInterrupt
                    main([directory, *options])
                    server.assert_called_once_with((host, port), Path(directory).resolve())

    def test_invalid_port_or_directory_does_not_start_server(self):
        with tempfile.TemporaryDirectory() as directory:
            for args in [[directory, '--port', '0'], [directory, '--port', '65536'],
                         [directory, '--port', 'invalid'], [str(Path(directory) / 'missing')]]:
                with patch('image_browser.cli.GalleryServer') as server, contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as error:
                        main(args)
                    self.assertEqual(error.exception.code, 2)
                    server.assert_not_called()
