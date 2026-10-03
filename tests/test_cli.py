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
                                        (['-p', '9090'], '127.0.0.1', 9090),
                                        (['--host', '0.0.0.0', '--port', '9090'], '0.0.0.0', 9090)]:
                with patch('image_browser.cli.GalleryServer') as server, contextlib.redirect_stdout(io.StringIO()):
                    running = server.return_value.__enter__.return_value
                    running.serve_forever.side_effect = KeyboardInterrupt
                    main([directory, *options])
                    server.assert_called_once_with((host, port), Path(directory).resolve())

    def test_invalid_port_or_directory_does_not_start_server(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'file.txt'
            file.write_text('not a directory')
            missing = str(Path(directory) / 'missing')
            for args, message in [([directory, '--port', '0'], 'port must be between 1 and 65535'),
                                  ([directory, '--port', '65536'], 'port must be between 1 and 65535'),
                                  ([directory, '--port', 'invalid'], 'invalid int value'),
                                  ([missing], f'directory does not exist: {missing}'),
                                  ([str(file)], f'not a directory: {file}')]:
                with self.subTest(args=args), patch('image_browser.cli.GalleryServer') as server, contextlib.redirect_stderr(io.StringIO()) as output:
                    with self.assertRaises(SystemExit) as error:
                        main(args)
                    self.assertEqual(error.exception.code, 2)
                    self.assertIn(message, output.getvalue())
                    server.assert_not_called()

    def test_inaccessible_directory_reports_the_actual_error(self):
        with tempfile.TemporaryDirectory() as directory:
            denied = PermissionError(13, 'Permission denied', directory)
            with patch('image_browser.cli.Path.stat', side_effect=denied), patch('image_browser.cli.GalleryServer') as server, contextlib.redirect_stderr(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as error:
                    main([directory])
                self.assertEqual(error.exception.code, 2)
                self.assertIn(f'unable to access directory {directory}: Permission denied', output.getvalue())
                self.assertNotIn('port', output.getvalue().split('error:')[-1])
                server.assert_not_called()
