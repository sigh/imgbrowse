"""On-demand metadata for one visible item, without traversing descendants."""

from contextlib import ExitStack
from datetime import datetime, timezone
from math import isfinite

from PIL import Image
from PIL.ExifTags import Base, GPS, IFD


def _capture_date(exif):
    """Preserve valid capture offsets; unknown offsets retain the naive camera time."""
    taken = exif.get(Base.DateTimeOriginal)
    if not taken:
        return None
    try:
        date = datetime.strptime(str(taken), '%Y:%m:%d %H:%M:%S')
    except ValueError:
        return str(taken)
    offset = exif.get(Base.OffsetTimeOriginal)
    if offset:
        try:
            date = date.replace(tzinfo=datetime.strptime(str(offset).strip(), '%z').tzinfo)
        except ValueError:
            pass
    return date.isoformat()


def _gps_location(gps):
    """Decode EXIF degrees/minutes/seconds into signed decimal coordinates."""
    try:
        location = {}
        for name, tag, reference, directions, limit in (
            ('latitude', GPS.GPSLatitude, GPS.GPSLatitudeRef, 'NS', 90),
            ('longitude', GPS.GPSLongitude, GPS.GPSLongitudeRef, 'EW', 180),
        ):
            degrees, minutes, seconds = map(float, gps[tag])
            direction = gps[reference]
            coordinate = degrees + minutes / 60 + seconds / 3600
            if (direction not in (directions[0], directions[1]) or not isfinite(coordinate)
                    or not 0 <= degrees <= limit or not 0 <= coordinate <= limit
                    or not 0 <= minutes < 60 or not 0 <= seconds < 60):
                return None
            location[name] = -coordinate if direction == directions[1] else coordinate
        return location
    except (KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError):
        return None


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
                fields = {Base.Make: 'Camera make', Base.Model: 'Camera model', Base.DateTime: 'Image date',
                          Base.Artist: 'Artist', Base.Copyright: 'Copyright', Base.Orientation: 'Orientation'}
                exif = image.getexif()
                result['exif'] = {label: str(value) for tag, label in fields.items()
                                  if (value := exif.get(tag)) is not None}
                taken = _capture_date(exif.get_ifd(IFD.Exif))
                if taken:
                    result['exif']['Taken'] = taken
                location = _gps_location(exif.get_ifd(IFD.GPSInfo))
                if location is not None:
                    result['location'] = location
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            result['metadata_error'] = str(error)
    return result
