"""Ordering, incremental seeking, metadata reuse, and archive regressions."""

import copy
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from image_browser.catalog import Gallery
from image_browser.ordering import Ordering
from image_browser.work import Cancelled, Invalidated, request_work


class OrderingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.gallery = Gallery(self.root)

    def file(self, name, modified):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture')
        os.utime(path, ns=(modified, modified))

    def sequence(self, ordering, reverse=False, anchor=None):
        cursor, images = None, []
        for _ in range(100):
            page = self.gallery.walk(ordering=ordering, reverse=reverse, anchor=anchor, cursor=cursor, limit=1)
            images.extend(page['images'])
            cursor = json.loads(json.dumps(page['cursor']))
            if cursor is None:
                return images
        self.fail('Traversal did not finish')

    def test_sorting_and_reverse_navigation_keep_directory_boundaries(self):
        for path, date in [('page1.jpg', 10), ('page2.jpg', 30), ('page10.jpg', 30),
                           ('chapter2/a.jpg', 100), ('chapter10/b.jpg', 200)]:
            self.file(path, date)
        os.utime(self.root / 'chapter2', ns=(10, 10))
        os.utime(self.root / 'chapter10', ns=(20, 20))
        for order, expected in [
            (Ordering(order='desc'),
             ['page10.jpg', 'page2.jpg', 'page1.jpg', 'chapter10/b.jpg', 'chapter2/a.jpg']),
            (Ordering(sort='modified', order='desc'),
             ['page2.jpg', 'page10.jpg', 'page1.jpg', 'chapter10/b.jpg', 'chapter2/a.jpg']),
            (Ordering(sort='modified'),
             ['page1.jpg', 'page2.jpg', 'page10.jpg', 'chapter2/a.jpg', 'chapter10/b.jpg']),
        ]:
            with self.subTest(order=order):
                self.assertEqual(self.sequence(order), expected)
                self.assertEqual(self.sequence(order, reverse=True), expected[::-1])
                for index, path in enumerate(expected):
                    self.assertEqual(self.sequence(order, anchor=path), expected[index + 1:])
                    self.assertEqual(self.sequence(order, reverse=True, anchor=path), expected[:index][::-1])

    def test_shared_modified_order_and_natural_covers(self):
        self.file('chapter2/page2.jpg', 200)
        self.file('chapter2/page10.jpg', 100)
        self.file('chapter10/page1.jpg', 300)
        os.utime(self.root / 'chapter2', ns=(10, 10))
        os.utime(self.root / 'chapter10', ns=(20, 20))
        order = Ordering(sort='modified', order='desc')
        self.assertEqual(self.sequence(order), ['chapter10/page1.jpg', 'chapter2/page2.jpg', 'chapter2/page10.jpg'])
        self.assertEqual(self.sequence(Ordering(sort='modified')),
                         ['chapter2/page10.jpg', 'chapter2/page2.jpg', 'chapter10/page1.jpg'])
        self.assertEqual(self.gallery.representative(''), 'chapter2/page2.jpg')
        self.assertEqual(self.gallery.listing('')['folders'], ['chapter2', 'chapter10'])

    def test_missing_and_equal_dates_stay_natural_in_both_directions(self):
        records = [('page10', 20), ('page2', 20), ('unknown10', None), ('unknown2', None), ('old', 0)]
        for direction, expected in [('asc', ['old', 'page2', 'page10', 'unknown2', 'unknown10']),
                                    ('desc', ['page2', 'page10', 'old', 'unknown2', 'unknown10'])]:
            order = Ordering('modified', direction)
            self.assertEqual([name for name, date in sorted(records, key=lambda item: order.key(*item))], expected)
        self.file('present.jpg', 0)
        self.file('missing.jpg', 100)
        self.gallery.listing('')
        (self.root / 'missing.jpg').unlink()
        self.assertEqual(self.gallery.listing('', ordering=Ordering(sort='modified', order='desc'))['images'],
                         ['present.jpg', 'missing.jpg'])

    def test_archive_dates_use_indexed_headers_and_missing_folder_dates(self):
        with zipfile.ZipFile(self.root / 'book.cbz', 'w') as archive:
            for name, date in [('page2.jpg', (2000, 1, 1, 0, 0, 0)), ('page10.jpg', (1990, 1, 1, 0, 0, 0)),
                               ('explicit/', (1980, 1, 1, 0, 0, 0)), ('explicit/a.jpg', (2010, 1, 1, 0, 0, 0)),
                               ('implicit/b.jpg', (2020, 1, 1, 0, 0, 0))]:
                archive.writestr(zipfile.ZipInfo(name, date), b'fixture')
        order = Ordering(sort='modified')
        with patch.object(zipfile.ZipFile, 'open', side_effect=AssertionError('Sorting read an archive payload')):
            self.assertEqual(self.gallery.listing('book.cbz', ordering=order)['images'], ['page10.jpg', 'page2.jpg'])
            self.assertEqual(self.gallery.listing('book.cbz', ordering=order)['folders'], ['explicit', 'implicit'])
            self.assertEqual(self.gallery.listing('book.cbz', ordering=Ordering(sort='modified', order='desc'))['folders'],
                             ['explicit', 'implicit'])
            self.assertEqual(self.sequence(order), ['book.cbz/page10.jpg', 'book.cbz/page2.jpg',
                                                   'book.cbz/explicit/a.jpg', 'book.cbz/implicit/b.jpg'])

    def test_continuations_bind_order_direction_root_generation_and_revision(self):
        self.file('a.jpg', 1_700_000_000_000_000_001)
        self.file('b.jpg', 1_700_000_000_000_000_002)
        order = Ordering(sort='modified')
        page = self.gallery.walk(ordering=order, limit=1)
        cursor = json.loads(json.dumps(page['cursor']))
        self.assertEqual(cursor['frames'][0]['position']['modified'], '1700000000000000001')
        for changes in [{'ordering': Ordering(sort='modified', order='desc')}, {'reverse': True}, {'root': 'other'}]:
            options = {'ordering': order, **changes}
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.gallery.walk(cursor=copy.deepcopy(cursor), **options)
        self.gallery.listings.invalidate()
        with self.assertRaisesRegex(ValueError, 'listing changed'):
            self.gallery.walk(cursor=copy.deepcopy(cursor), ordering=order)
        self.gallery.invalidate('')
        with self.assertRaisesRegex(ValueError, 'no longer matches'):
            self.gallery.walk(cursor=cursor, ordering=order)

    def test_modified_deep_anchor_does_not_scan_earlier_subtrees(self):
        self.file('chapter1/a.jpg', 1)
        self.file('chapter99/b.jpg', 2)
        self.file('chapter99/c.jpg', 3)
        with patch.object(self.gallery, '_listing', wraps=self.gallery._listing) as listing:
            page = self.gallery.walk(anchor='chapter99/b.jpg', ordering=Ordering(sort='modified'), limit=1)
            self.assertEqual(page['images'], ['chapter99/c.jpg'])
            self.assertEqual([call.args[0] for call in listing.call_args_list], ['chapter99'])

    def test_cancelled_or_refreshed_attribute_work_cannot_publish(self):
        self.file('a.jpg', 100)
        self.gallery.listing('')
        with request_work(cancel=lambda: True), self.assertRaises(Cancelled):
            self.gallery.listing('', ordering=Ordering(sort='modified'))
        original = self.gallery._ordered_snapshot
        def refreshed(*args):
            result = original(*args)
            self.gallery.invalidate('')
            return result
        with patch.object(self.gallery, '_ordered_snapshot', side_effect=refreshed), self.assertRaises(Invalidated):
            self.gallery.listing('', ordering=Ordering(sort='modified'))
        self.assertEqual(self.gallery.ordered.weight, 0)

    def test_sort_inputs_are_strictly_validated(self):
        for settings in [{'sort':'capture'}, {'order':'backwards'}, {'sort':None}, {'order':False}]:
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                Ordering.from_params(settings)
