"""Request-scoped output directory context. Set once per request by the
endpoint wrapper in main.py, read by finalize_output_path and op handlers."""
from contextvars import ContextVar

_output_dir_ctx: ContextVar[str | None] = ContextVar("output_dir", default=None)


def set_output_dir(path: str | None) -> None:
    _output_dir_ctx.set(path)


def get_output_dir() -> str | None:
    return _output_dir_ctx.get()
