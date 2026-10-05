"""Short-lived negative reuse for permanent source-access failures."""


def cache_storage_error(error):
    """Generic storage/capacity errors remain retryable and are never retained."""
    return isinstance(error, (FileNotFoundError, NotADirectoryError, PermissionError, ValueError))
