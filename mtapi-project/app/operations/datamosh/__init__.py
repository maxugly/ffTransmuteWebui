"""datamosh operation package — auto-registers all modes on import."""
from .common import _execute_mosh_pipeline, _trim_and_mosh, _probe_has_audio, _slice_segment
from .melt import datamosh_melt
from .classic import datamosh_classic
from .hijack import datamosh_hijack
from .destruct import datamosh_destruct
from .mv_hack import datamosh_mv_hack
