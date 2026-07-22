"""
Importing this package is what populates contract.REGISTRY — each
operations module calls register() at import time as a side effect.

Adding a new tool later means: write a new <thing>_ops.py next to these
two, following the pattern in transmute_ops.py, then add one import line
below. Nothing else needs to change — main.py builds routes from
whatever's in the registry.
"""
from . import (  # noqa: F401
    transmute_ops,
    datamosh_ops,
    deepdream_ops,
    facemorph_ops,
    withoutbg_ops,
    styletransfer_ops,
)
