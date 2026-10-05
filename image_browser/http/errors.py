"""Translate application failures into HTTP responses."""

from image_browser.catalog.errors import OrderTooLarge, StaleView
from image_browser.runtime.work import Busy, Invalidated


def error_details(error):
    if isinstance(error, OrderTooLarge):
        status, code, retryable = 413, 'order_too_large', False
    elif isinstance(error, Busy):
        status, code, retryable = 503, 'storage_busy', True
    elif isinstance(error, (StaleView, Invalidated)):
        status, code, retryable = 409, 'stale_view', False
    elif isinstance(error, (FileNotFoundError, NotADirectoryError)):
        status, code, retryable = 404, 'not_found', False
    elif isinstance(error, PermissionError):
        status, code, retryable = 403, 'unreadable', False
    elif isinstance(error, ValueError):
        status, code, retryable = 400, 'invalid_request', False
    elif isinstance(error, OSError):
        status, code, retryable = 503, 'storage_error', True
    else:
        status, code, retryable = 500, 'internal_error', False
    return status, {'error': str(error), 'code': code, 'retryable': retryable}
