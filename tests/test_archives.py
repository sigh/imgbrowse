"""ZIP/CBZ traversal, image delivery, and safety regressions."""

import io
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image

from image_browser.catalog import Gallery
from image_browser.thumbnails import ThumbnailCache


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.gallery = Gallery(self.root)
        image = Image.new('RGB', (16, 24), 'green')
        buffer = io.BytesIO()
        image.save(buffer, 'JPEG')
        self.image = buffer.getvalue()

    def make_archive(self, name='Book 2.cbz'):
        path = self.root / name
        with zipfile.ZipFile(path, 'w') as archive:
            for member in ('page10.jpg', 'page2.jpg', 'Chapter 2/2.jpg',
                           'Chapter 2/1.jpg', 'Chapter 10/page1.jpg'):
                archive.writestr(member, self.image)
            archive.writestr('.hidden.jpg', self.image)
            archive.writestr('../outside.jpg', self.image)
            archive.writestr('Chapter 2/../../escape.jpg', self.image)
            archive.writestr('notes.txt', b'no image')
            link = zipfile.ZipInfo('shortcut.jpg')
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, b'page2.jpg')
        return path

    def sequence(self, **options):
        images, cursor = [], None
        while True:
            page = self.gallery.walk(cursor=cursor, limit=2, **options)
            images.extend(page['images'])
            cursor = page['cursor']
            if cursor is None:
                return images

    def test_virtual_folders_preview_natural_order_and_anchors(self):
        self.make_archive()
        Image.new('RGB', (8, 8), 'blue').save(self.root / 'cover.jpg')
        self.assertEqual(self.gallery.listing(''),
                         {'folders': ['Book 2.cbz'], 'images': ['cover.jpg']})
        self.assertEqual(self.gallery.listing('Book 2.cbz'),
                         {'folders': ['Chapter 2', 'Chapter 10'],
                          'images': ['page2.jpg', 'page10.jpg']})
        self.assertEqual(self.gallery.preview('Book 2.cbz')['image'], 'Book 2.cbz/page2.jpg')
        expected = ['cover.jpg', 'Book 2.cbz/page2.jpg', 'Book 2.cbz/page10.jpg',
                    'Book 2.cbz/Chapter 2/1.jpg', 'Book 2.cbz/Chapter 2/2.jpg',
                    'Book 2.cbz/Chapter 10/page1.jpg']
        self.assertEqual(self.sequence(), expected)
        self.assertEqual(self.sequence(reverse=True), expected[::-1])
        self.assertEqual(self.sequence(root='Book 2.cbz'), expected[1:])
        anchor = 'Book 2.cbz/Chapter 2/1.jpg'
        self.assertEqual(self.sequence(root='Book 2.cbz', anchor=anchor), expected[4:])
        self.assertEqual(self.sequence(root='Book 2.cbz', anchor=anchor, reverse=True),
                         expected[1:3][::-1])

    def test_rejects_unsafe_and_missing_members(self):
        self.make_archive()
        for path in ('Book 2.cbz/.hidden.jpg', 'Book 2.cbz/../outside.jpg',
                     'Book 2.cbz/shortcut.jpg', 'Book 2.cbz/notes.txt'):
            with self.subTest(path=path), self.assertRaises((ValueError, FileNotFoundError)):
                self.gallery.image_source(path)
        with self.assertRaises(FileNotFoundError):
            self.gallery.listing('Book 2.cbz/missing')
        (self.root / 'bad.zip').write_bytes(b'not a zip')
        with self.assertRaises(ValueError):
            self.gallery.listing('bad.zip')

    def test_physical_locations_distinguish_archive_members_and_real_folders(self):
        archive = self.make_archive()
        self.assertEqual(self.gallery.location('Book 2.cbz/Chapter 2'), {
            'filesystem_path': str(archive.resolve()), 'archive_member': 'Chapter 2'})
        directory = self.root / 'Actual.zip'
        directory.mkdir()
        (directory / 'page.jpg').write_bytes(self.image)
        self.assertEqual(self.gallery.location('Actual.zip'), {
            'filesystem_path': str(directory.resolve()), 'archive_member': None})
        self.assertEqual(self.gallery.listing('Actual.zip')['images'], ['page.jpg'])
        self.assertIsNone(self.gallery.source('Actual.zip/page.jpg').member)
        with self.assertRaises(ValueError):
            self.gallery.location('Book 2.cbz/../outside')
        (self.root / 'link.cbz').symlink_to(archive)
        with self.assertRaises(ValueError):
            self.gallery.location('link.cbz/Chapter 2')

    def test_source_identity_keeps_member_and_file_versions_separate(self):
        self.make_archive()
        first = self.gallery.source('Book 2.cbz/page2.jpg')
        second = self.gallery.source('Book 2.cbz/page10.jpg')
        self.assertEqual(first.file, second.file)
        self.assertNotEqual(first.cache_key, second.cache_key)
        self.assertEqual(first.size, len(self.image))
        (self.root / 'loose.jpg').write_bytes(self.image)
        loose = self.gallery.source('loose.jpg')
        self.assertIsNone(loose.member)
        self.assertEqual(loose.size, len(self.image))
        self.assertNotEqual(loose.etag, first.etag)

    def test_member_bytes_thumbnail_and_refresh(self):
        archive = self.make_archive()
        file, member = self.gallery.image_source('Book 2.cbz/page2.jpg')
        self.assertEqual(file, archive.resolve())
        with zipfile.ZipFile(file) as source:
            self.assertEqual(source.read(member), self.image)
        thumbnails = ThumbnailCache()
        key = (str(file), file.stat().st_mtime_ns, member.CRC)
        result = thumbnails.get_archive(key, lambda: self.image)
        with Image.open(io.BytesIO(result)) as image:
            self.assertEqual(image.size, (16, 24))
        self.assertEqual(thumbnails.get_archive(key, lambda: self.fail('decoded twice')), result)
        with zipfile.ZipFile(archive, 'a') as source:
            source.writestr('page3.jpg', self.image)
        self.assertEqual(self.gallery.listing('Book 2.cbz')['images'],
                         ['page2.jpg', 'page3.jpg', 'page10.jpg'])


if __name__ == '__main__':
    unittest.main()
