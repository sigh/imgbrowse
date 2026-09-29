"""Media identity distinguishes loose files from images inside archives."""

from dataclasses import dataclass
from os import stat_result
from pathlib import Path
from typing import Optional
from zipfile import ZipInfo

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}


VIDEO_TYPES = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
               '.ogv': 'video/ogg', '.mov': 'video/quicktime'}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_TYPES.keys()


@dataclass(frozen=True)
class MediaSource:
    """A physical file version, optionally identifying an image within it."""

    file: Path
    stat: stat_result
    member: Optional[ZipInfo] = None

    @property
    def kind(self):
        return 'video' if self.member is None and self.file.suffix.lower() in VIDEO_TYPES else 'image'

    @property
    def size(self):
        return self.member.file_size if self.member is not None else self.stat.st_size

    @property
    def cache_key(self):
        key = (str(self.file), self.stat.st_mtime_ns, self.stat.st_size)
        if self.member is not None:
            key += (self.member.filename, self.member.CRC, self.member.file_size)
        return key

    @property
    def etag(self):
        version = f'{self.stat.st_mtime_ns}-{self.stat.st_size}'
        if self.member is not None:
            version += f'-{self.member.CRC}-{self.member.file_size}'
        return f'"{version}"'
