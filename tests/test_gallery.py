"""Traversal and request regressions for large, nested collections."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from image_browser.catalog import WALK_BUDGET, Gallery


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.gallery = Gallery(self.root)

    def image(self, path):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (12, 18), 'blue').save(file)
        return path

    def sequence(self, **kwargs):
        images, cursor = [], None
        for _ in range(100):
            result = self.gallery.walk(cursor=cursor, **kwargs)
            images.extend(result['images'])
            cursor = result['cursor']
            if cursor is None:
                return images
        self.fail('Traversal did not terminate')

    def test_natural_order_and_reverse_across_boundaries(self):
        expected = ['page2.jpg', 'page10.jpg', 'chapter2/1.jpg',
                    'chapter2/nested/1.jpg', 'chapter10/1.jpg']
        for path in reversed(expected):
            self.image(path)
        self.assertEqual(self.sequence(limit=1), expected)
        self.assertEqual(self.sequence(limit=2, reverse=True), expected[::-1])
        for index, path in enumerate(expected):
            self.assertEqual(self.sequence(anchor=path, limit=2), expected[index + 1:])
            self.assertEqual(self.sequence(anchor=path, reverse=True, limit=2), expected[:index][::-1])

    def test_subcollection_anchor_does_not_scan_earlier_folders(self):
        self.image('album/chapter1/a.jpg')
        anchor = self.image('album/chapter99/b.jpg')
        self.image('album/chapter99/c.jpg')
        with patch.object(self.gallery, 'listing', wraps=self.gallery.listing) as listing:
            result = self.gallery.walk(root='album', anchor=anchor, limit=1)
            self.assertEqual(result['images'], ['album/chapter99/c.jpg'])
            self.assertEqual([call.args[0] for call in listing.call_args_list], ['album/chapter99'])

    def test_preview_never_backtracks_but_viewer_does(self):
        (self.root / 'series/first/leaf').mkdir(parents=True)
        image = self.image('series/second/1.jpg')
        with patch.object(self.gallery, 'listing', wraps=self.gallery.listing) as listing:
            self.assertEqual(self.gallery.preview('series'), {'image': None})
            self.assertEqual([call.args[0] for call in listing.call_args_list],
                             ['series', 'series/first', 'series/first/leaf'])
        self.assertEqual(self.sequence(root='series'), [image])

    def test_preview_prefers_direct_images(self):
        self.image('series/a.jpg')
        self.image('series/nested/1.jpg')
        self.assertEqual(self.gallery.preview('series')['image'], 'series/a.jpg')

    def test_walk_and_preview_have_bounded_directory_work(self):
        for number in range(WALK_BUDGET + 10):
            (self.root / f'empty{number}').mkdir()
        with patch.object(self.gallery, 'listing', wraps=self.gallery.listing) as listing:
            result = self.gallery.walk()
            self.assertLessEqual(listing.call_count, WALK_BUDGET)
            self.assertIsNotNone(result['cursor'])
        deep = '/'.join(['deep'] * (WALK_BUDGET + 2))
        self.image(deep + '/1.jpg')
        with patch.object(self.gallery, 'listing', wraps=self.gallery.listing) as listing:
            result = self.gallery.preview('deep')
            self.assertEqual(listing.call_count, WALK_BUDGET)
            self.assertIn('continue', result)
        self.assertEqual(self.gallery.preview(result['continue'])['image'], deep + '/1.jpg')

    def test_hidden_symlinks_empty_and_nonimages(self):
        self.image('visible/1.jpg')
        self.image('.hidden/1.jpg')
        (self.root / 'empty').mkdir()
        (self.root / 'notes.txt').write_text('notes')
        (self.root / 'link').symlink_to(self.root / 'visible', target_is_directory=True)
        self.assertEqual(self.gallery.listing('')['folders'], ['empty', 'visible'])
        for path in ['../outside', '/etc/passwd', '.hidden/1.jpg', 'link/1.jpg']:
            with self.assertRaises(ValueError):
                self.gallery.resolve(path)
        self.assertEqual(self.sequence(), ['visible/1.jpg'])

    def test_refresh_and_deleted_anchor(self):
        self.image('1.jpg')
        self.image('3.jpg')
        self.assertEqual(self.gallery.walk(anchor='2.jpg', limit=1)['images'], ['3.jpg'])
        self.image('2.jpg')
        self.assertEqual(self.gallery.listing('')['images'], ['1.jpg', '2.jpg', '3.jpg'])

    def test_anchor_cannot_escape_collection(self):
        self.image('a/1.jpg')
        with self.assertRaises(ValueError):
            self.gallery.walk(root='b', anchor='a/1.jpg')

    def test_malformed_walk_inputs_have_consistent_errors(self):
        requests = [
            {'root': None}, {'anchor': []}, {'limit': True}, {'reverse': 'false'},
            {'cursor': [{}]}, {'cursor': [None]},
            {'cursor': [{'path': '', 'phase': 0, 'after': 5}]},
        ]
        for request in requests:
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.gallery.walk(**request)


if __name__ == '__main__':
    unittest.main()
