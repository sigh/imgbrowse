"""On-demand metadata for one visible item, without traversing descendants."""

from contextlib import ExitStack
from datetime import datetime, timezone

from PIL import Image


def metadata(gallery, relative, image_work, archive_work):
    with gallery.directory_work:
        entry = gallery._locate(relative)
    result = {
        'name': relative.rsplit('/', 1)[-1] if relative else gallery.root.name,
        'filesystem_path': str(entry.file),
        'archive_member': entry.inner if entry.archive else None,
        'modified': datetime.fromtimestamp(entry.stat.st_mtime, timezone.utc).isoformat(),
    }
    if entry.is_container:
        result['kind'] = 'archive' if entry.archive and not entry.inner else 'directory'
        listing = gallery.listing(relative, entry=entry)
        result.update(folders=len(listing['folders']), media=len(listing['images']))
        if entry.archive:
            result['archive_size'] = entry.stat.st_size
        return result

    source = entry.media_source()
    result.update(kind=source.kind, size=source.size)
    if source.member:
        result['modified'] = datetime(*source.member.date_time).isoformat()
        result['compressed_size'] = source.member.compress_size
    if source.kind == 'image':
        try:
            with ExitStack() as stack:
                stack.enter_context(archive_work if source.member else image_work)
                stream = stack.enter_context(entry.archive.open(source.member) if source.member
                                             else entry.file.open('rb'))
                image = stack.enter_context(Image.open(stream))
                result.update(width=image.width, height=image.height, format=image.format,
                              color_mode=image.mode)
                fields = {271: 'Camera make', 272: 'Camera model', 306: 'Image date',
                          315: 'Artist', 33432: 'Copyright', 274: 'Orientation'}
                exif = image.getexif()
                result['exif'] = {label: str(value) for tag, label in fields.items()
                                  if (value := exif.get(tag)) is not None}
                taken = exif.get_ifd(34665).get(36867) if 34665 in exif else None
                if taken:
                    try:
                        result['exif']['Taken'] = datetime.strptime(str(taken), '%Y:%m:%d %H:%M:%S').isoformat()
                    except ValueError:
                        result['exif']['Taken'] = str(taken)
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            result['metadata_error'] = str(error)
    return result
