"""Catalog failures, independent of transport and cache policy."""


class StaleView(ValueError):
    """The membership or ordering represented by a client revision changed."""


class InvalidSelection(ValueError):
    """The requested identity does not match the selected item's type."""


class OrderTooLarge(ValueError):
    """A complete ordered projection cannot fit in the live working-set budget."""
