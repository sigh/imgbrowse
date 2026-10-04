"""Metadata API reports the selected item and preserves collection boundaries."""

import io
import json
import tempfile
import unittest
import zipfile
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from urllib.parse import urlencode

from PIL import Image
from PIL.ExifTags import Base, GPS, IFD
from PIL.TiffImagePlugin import IFDRational

from image_browser.metadata import _gps_location
from image_browser.server import GalleryServer


class MetadataTests(unittest.TestCase):
    def test_folder_pages_never_decode_images_and_reject_traversal(self):
        modified = self.request('photo.jpg')[1]['modified']
        for names, expected_status in [(['photo.jpg'], 200), (['../photo.jpg'], 400)]:
            connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
            try:
                with patch('image_browser.metadata.Image.open', side_effect=AssertionError('No decoding')):
                    connection.request('GET', '/api/folder?' + urlencode({'path':'', 'names':json.dumps(names)}))
                    response = connection.getresponse()
                    data = json.loads(response.read())
                    self.assertEqual(response.status, expected_status)
                    if expected_status == 200:
                        self.assertEqual(data['entries'], [{'name':'photo.jpg', 'type':'image', 'modified':modified}])
                        self.assertNotIn('images', data)
            finally:
                connection.close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.server = GalleryServer(('127.0.0.1', 0), self.root)
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        buffer = io.BytesIO()
        exif = Image.Exif()
        exif[272] = 'Test camera'
        exif[34665] = {36867: '2024:03:14 12:30:00'}
        exif[IFD.GPSInfo] = {GPS.GPSLatitudeRef: 'S', GPS.GPSLatitude: (33, 51, IFDRational(36)),
                             GPS.GPSLongitudeRef: 'E', GPS.GPSLongitude: (151, 12, IFDRational(0))}
        Image.new('RGB', (40, 60)).save(buffer, 'JPEG', exif=exif)
        self.image = buffer.getvalue()
        (self.root / 'photo.jpg').write_bytes(self.image)

    def request(self, path):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request('GET', '/api/metadata?' + urlencode({'path': path}))
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_image_details_and_location(self):
        status, data = self.request('photo.jpg')
        self.assertEqual(status, 200)
        self.assertEqual(data['root_path'], str(self.root))
        self.assertEqual(data['filesystem_path'], str(self.root / 'photo.jpg'))
        self.assertEqual((data['width'], data['height'], data['format']), (40, 60, 'JPEG'))
        self.assertEqual(data['size'], len(self.image))
        self.assertEqual(data['exif']['Camera model'], 'Test camera')
        self.assertEqual(data['exif']['Taken'], '2024-03-14T12:30:00')
        self.assertAlmostEqual(data['location']['latitude'], -33.86)
        self.assertAlmostEqual(data['location']['longitude'], 151.2)
        self.assertIsNone(data['archive_member'])

    def test_capture_offsets_survive_loose_and_archived_images(self):
        for index, (offset, expected) in enumerate([
            ('+02:00', '+02:00'), ('-05:30', '-05:30'), ('+00:00', '+00:00'),
            (None, ''), ('invalid', ''), ('+25:00', ''),
        ]):
            with self.subTest(offset=offset):
                exif = Image.Exif()
                fields = {Base.DateTimeOriginal: '2026:10:04 10:00:00'}
                if offset is not None:
                    fields[Base.OffsetTimeOriginal] = offset
                exif[IFD.Exif] = fields
                exif[Base.Model] = 'Test camera'
                buffer = io.BytesIO()
                Image.new('RGB', (40, 60)).save(buffer, 'JPEG', exif=exif)
                name = f'offset{index}.jpg'
                (self.root / name).write_bytes(buffer.getvalue())
                archive_name = f'offset{index}.cbz'
                with zipfile.ZipFile(self.root / archive_name, 'w') as archive:
                    archive.writestr(name, buffer.getvalue())
                for path in [name, f'{archive_name}/{name}']:
                    status, data = self.request(path)
                    self.assertEqual(status, 200)
                    self.assertEqual(data['exif']['Taken'], '2026-10-04T10:00:00' + expected)
                    self.assertEqual(data['exif']['Camera model'], 'Test camera')
                    self.assertNotIn('metadata_error', data)

    def test_directory_counts_do_not_traverse_descendants(self):
        (self.root / 'nested').mkdir()
        (self.root / 'nested/deeper').mkdir()
        (self.root / 'nested/deeper/other.jpg').write_bytes(self.image)
        (self.root / 'notes.txt').write_text('ignored')
        with patch.object(self.server.gallery, '_scan_directory',
                          wraps=self.server.gallery._scan_directory) as scan:
            status, data = self.request('')
            self.assertEqual(status, 200)
            self.assertEqual((data['kind'], data['folders'], data['media']), ('directory', 1, 1))
            self.assertEqual(scan.call_count, 1)

    def test_archive_members_and_virtual_folders(self):
        with zipfile.ZipFile(self.root / 'book.cbz', 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('chapter/page.jpg', self.image)
        status, data = self.request('book.cbz/chapter/page.jpg')
        self.assertEqual(status, 200)
        self.assertEqual(data['archive_member'], 'chapter/page.jpg')
        self.assertEqual(data['filesystem_path'], str(self.root / 'book.cbz'))
        self.assertEqual((data['width'], data['height'], data['size']), (40, 60, len(self.image)))
        self.assertAlmostEqual(data['location']['latitude'], -33.86)
        self.assertAlmostEqual(data['location']['longitude'], 151.2)
        self.assertLess(data['compressed_size'], data['size'])
        self.assertEqual(self.request('book.cbz')[1]['kind'], 'archive')
        folder = self.request('book.cbz/chapter')[1]
        self.assertEqual((folder['kind'], folder['folders'], folder['media']), ('directory', 0, 1))
        self.assertEqual(self.request('book.cbz/missing')[0], 404)

    def test_unreadable_image_still_has_file_details(self):
        (self.root / 'broken.jpg').write_bytes(b'broken')
        status, data = self.request('broken.jpg')
        self.assertEqual(status, 200)
        self.assertEqual(data['size'], 6)
        self.assertIn('metadata_error', data)

    def test_other_files_share_metadata_without_decoding(self):
        (self.root / 'sunrise.heic').write_bytes(b'unsupported image')
        with zipfile.ZipFile(self.root / 'trip.zip', 'w') as archive:
            archive.writestr('chapter/clip.mp4', b'unsupported archived video')
            archive.writestr('chapter/notes.txt', b'notes')
        with patch('image_browser.metadata.Image.open', side_effect=AssertionError('Other files must not be decoded')):
            for path, size, member in [('sunrise.heic', 17, None),
                                       ('trip.zip/chapter/clip.mp4', 26, 'chapter/clip.mp4'),
                                       ('trip.zip/chapter/notes.txt', 5, 'chapter/notes.txt')]:
                with self.subTest(path=path):
                    status, data = self.request(path)
                    self.assertEqual(status, 200)
                    self.assertEqual((data['kind'], data['size'], data['archive_member']), ('file', size, member))
                    self.assertIn('modified', data)
                    self.assertNotIn('metadata_error', data)
                    with self.assertRaises(ValueError):
                        self.server.gallery.source(path)

    def test_image_without_gps_has_no_location(self):
        Image.new('RGB', (40, 60)).save(self.root / 'plain.jpg')
        status, data = self.request('plain.jpg')
        self.assertEqual(status, 200)
        self.assertNotIn('location', data)
        self.assertNotIn('metadata_error', data)

    def test_gps_coordinates_require_both_axes_and_valid_values(self):
        gps = {GPS.GPSLatitudeRef: 'N', GPS.GPSLatitude: (0, 0, 0),
               GPS.GPSLongitudeRef: 'W', GPS.GPSLongitude: (74, 0, 0)}
        self.assertEqual(_gps_location(gps), {'latitude': 0, 'longitude': -74})
        for invalid in [{}, {**gps, GPS.GPSLatitudeRef: ''}, {**gps, GPS.GPSLatitudeRef: 'X'},
                        {**gps, GPS.GPSLatitude: (91, 0, 0)}, {**gps, GPS.GPSLatitude: (33, 60, 0)},
                        {**gps, GPS.GPSLatitude: (33, 0)}, {**gps, GPS.GPSLatitude: (float('nan'), 0, 0)},
                        {**gps, GPS.GPSLongitude: (74, 0, IFDRational(0, 0))}]:
            with self.subTest(gps=invalid):
                self.assertIsNone(_gps_location(invalid))

    def test_rejects_hidden_escaping_missing_and_symlink_paths(self):
        (self.root / 'link.jpg').symlink_to(self.root / 'photo.jpg')
        for path in ['../photo.jpg', '/etc/passwd', '.hidden.jpg', 'link.jpg', 'missing.jpg']:
            with self.subTest(path=path):
                self.assertIn(self.request(path)[0], (400, 404))


if __name__ == '__main__':
    unittest.main()
