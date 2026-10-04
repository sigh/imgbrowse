"""Optional FFmpeg extraction, with bounded runtime and cancellation."""

import json
import math
import shutil
import subprocess
from time import monotonic

from .work import check_cancelled

EXTRACTION_TIMEOUT = 10


def render_video_thumbnail(file, size):
    executable = shutil.which('ffmpeg')
    if executable is None:
        raise ValueError('FFmpeg is not installed')
    deadline = monotonic() + EXTRACTION_TIMEOUT
    width, height = size
    for offset in ('1', '0'):
        check_cancelled()
        command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
                   '-threads', '1', '-ss', offset, '-i', str(file),
                   '-map', '0:v:0', '-frames:v', '1', '-an', '-sn',
                   '-vf', f'scale={width}:{height}:force_original_aspect_ratio=decrease',
                   '-threads', '1', '-filter_threads', '1', '-f', 'image2pipe',
                   '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1']
        output = run_video_tool(command, deadline)
        if output:
            return output
    raise ValueError('No video frame available')


def run_video_tool(command, deadline):
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            while True:
                check_cancelled()
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise ValueError('Video preview timed out')
                try:
                    output, _ = process.communicate(timeout=min(.1, remaining))
                    return output if process.returncode == 0 else b''
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()


def video_metadata(file):
    executable = shutil.which('ffprobe')
    if executable is None:
        return {}
    output = run_video_tool([executable, '-v', 'error', '-select_streams', 'v:0',
                             '-show_entries', 'stream=width,height:format=duration',
                             '-of', 'json', str(file)], monotonic() + EXTRACTION_TIMEOUT)
    try:
        data = json.loads(output)
    except (ValueError, TypeError):
        return {}
    info = {}
    try:
        duration = float(data['format']['duration'])
        if math.isfinite(duration) and duration >= 0:
            info['duration'] = duration
    except (ValueError, KeyError, TypeError):
        pass
    try:
        stream = data['streams'][0]
        width, height = int(stream['width']), int(stream['height'])
        if width > 0 and height > 0:
            info.update(width=width, height=height)
    except (ValueError, KeyError, TypeError, IndexError):
        pass
    return info
