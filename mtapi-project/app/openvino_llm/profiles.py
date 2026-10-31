"""Model/engine scoped controls and presets; no prompts or client overrides."""
from __future__ import annotations

import json
import math
import threading
from pathlib import Path

from .config import ModelEntry, RuntimeConfig, load_config, settings_path

RUNTIME_KEYS = (
    'device', 'kv_cache_precision', 'ovms_cache_size_gb', 'ovms_max_num_seqs',
    'ovms_max_num_batched_tokens', 'ovms_enable_prefix_caching', 'ovms_dynamic_split_fuse',
)
GENERATION_KEYS = (
    'context_window', 'max_tokens', 'max_tokens_default', 'temperature_default',
    'top_p_default', 'top_k_default', 'repetition_penalty_default', 'enable_thinking_default',
)
_LOCK = threading.RLock()


def effective_runtime(cfg, entry):
    rt = cfg.runtime.model_copy(deep=True)
    for key, value in entry.runtime_profiles.get(rt.engine, {}).items():
        if key in RUNTIME_KEYS:
            setattr(rt, key, value)
    return rt


def describe(entry, engine='playground', device='GPU'):
    from .catalog import model_catalog, resources_dir
    row = next((r for r in model_catalog()['models'] if r['id'] == entry.id), None)
    native_limit = row['native_context_window'] if row else entry.context_window
    caps = dict(row['entry']['capabilities'] if row else entry.capabilities.model_dump())
    caps['vision'] = bool(row and row['supports_vision'] and engine == 'playground')
    thinking = bool(row['supports_thinking_toggle']) if row else supports_thinking(entry)
    npu = device.startswith('NPU')
    rt_defaults = RuntimeConfig().model_dump()
    # Playground does not explicitly force KV precision: inherit OVMS by default.
    rt_defaults['kv_cache_precision'] = 'auto'
    runtime = ['device']
    if not npu:
        runtime += ['kv_cache_precision']
        if engine == 'playground':
            runtime += list(RUNTIME_KEYS[2:])
    generation = list(GENERATION_KEYS)
    if not thinking:
        generation.remove('enable_thinking_default')
    inherited = {}
    try:
        inherited = json.loads((Path(entry.model_path) / 'generation_config.json').read_text())
    except (OSError, ValueError):
        pass
    profiles = []
    source = resources_dir() / 'modes/base/presets'
    # Bundled snapshot of installed Playground factories; never read user overrides.
    modes = [('advanced-chat', 'Advanced Chat', 2048), ('basic-chat', 'Basic Chat', 2048),
             ('reasoning', 'Reasoning', 2048), ('agentic-chat', 'Agentic', 2047)]
    for ident, label, output in modes:
        if ident == 'reasoning' and not caps.get('reasoning'):
            continue
        if ident == 'agentic-chat' and not caps.get('tools'):
            continue
        mode = {'contextSize': 8192, 'maxNewTokens': output}
        provenance = 'Bundled Playground factory snapshot (2026-10-23)'
        try:
            mode = json.loads((source / f'{ident}.json').read_text())
            provenance = str(source / f'{ident}.json')
        except (OSError, ValueError):
            pass
        values = {
            'context_window': min(native_limit, int(mode.get('contextSize', 8192))),
            'max_tokens': min(native_limit, int(mode.get('maxNewTokens', output))),
            'max_tokens_default': min(native_limit, int(mode.get('maxNewTokens', output))),
            'temperature_default': float(mode.get('temperature', .7)),
            'top_p_default': None, 'top_k_default': None, 'repetition_penalty_default': None,
        }
        if thinking:
            values['enable_thinking_default'] = True
        factory_runtime = list(RUNTIME_KEYS) if engine == 'playground' else list(RUNTIME_KEYS[:2])
        values['runtime'] = {k: rt_defaults[k] for k in factory_runtime}
        # Modes differing only in prompts/tools are one model-settings factory.
        duplicate = next((p for p in profiles if p['values'] == values), None)
        if duplicate:
            duplicate['name'] += f' / {label}'
        else:
            profiles.append({'id': ident, 'name': label, 'values': values, 'source': provenance})
    return {
        'ok': True, 'model_id': entry.id, 'identity': row.get('preset_identity', row['repo_id']) if row else f'local:{entry.id}:{entry.model_path}',
        'engine': engine, 'native_context_window': native_limit, 'capabilities': caps,
        'generation_keys': generation, 'runtime_keys': runtime,
        'devices': ['GPU', 'CPU', 'AUTO'] + (['NPU'] if row and row['npu_support'] else []),
        'thinking_toggle': thinking, 'factory_profiles': profiles,
        'inherited_generation': {k: inherited[k] for k in ('top_p', 'top_k', 'repetition_penalty') if k in inherited},
    }


def validate_profile(values, descriptor):
    if not isinstance(values, dict):
        raise ValueError('Preset settings must be an object')
    allowed = set(descriptor['generation_keys']) | {'runtime'}
    if set(values) - allowed:
        raise ValueError('Unsupported settings for this model: ' + ', '.join(sorted(set(values) - allowed)))
    result = dict(values)
    runtime = result.get('runtime', {})
    if not isinstance(runtime, dict) or set(runtime) - set(descriptor['runtime_keys']):
        raise ValueError('Unsupported runtime settings for this model, engine or device')
    if runtime.get('device', 'GPU') not in descriptor['devices']:
        raise ValueError('Device is not supported by this model')
    if runtime.get('kv_cache_precision', 'auto') not in {'auto', 'u4', 'u8', 'f16'}:
        raise ValueError('Invalid KV cache precision')
    ranges = {
        'context_window': (512, descriptor['native_context_window']),
        'max_tokens': (1, descriptor['native_context_window']),
        'max_tokens_default': (1, descriptor['native_context_window']),
        'temperature_default': (0, 2), 'top_p_default': (0.000001, 1),
        'top_k_default': (-1 if descriptor['engine'] == 'playground' else 0, 1000000), 'repetition_penalty_default': (0.000001, 10),
        'ovms_cache_size_gb': (0, 64), 'ovms_max_num_seqs': (1, 4096),
        'ovms_max_num_batched_tokens': (0, 2097152),
    }
    integer = {'context_window', 'max_tokens', 'max_tokens_default', 'top_k_default',
               'ovms_cache_size_gb', 'ovms_max_num_seqs', 'ovms_max_num_batched_tokens'}
    for container in (result, runtime):
        for key, value in container.items():
            if key not in ranges:
                continue
            if value is None and key in {'temperature_default', 'top_p_default', 'top_k_default', 'repetition_penalty_default'}:
                continue
            lo, hi = ranges[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi:
                raise ValueError(f'{key} must be between {lo} and {hi}')
            if key in integer and int(value) != value:
                raise ValueError(f'{key} must be an integer')
    for key in ('enable_thinking_default', 'ovms_enable_prefix_caching', 'ovms_dynamic_split_fuse'):
        container = runtime if key.startswith('ovms_') else result
        if key in container and not isinstance(container[key], bool):
            raise ValueError(f'{key} must be true or false')
    if result.get('max_tokens_default', 1) > result.get('max_tokens', descriptor['native_context_window']):
        raise ValueError('Default reply tokens cannot exceed the reply cap')
    if result.get('max_tokens', 1) > result.get('context_window', descriptor['native_context_window']):
        raise ValueError('Reply cap cannot exceed context capacity')
    return result


def resolve_model(model_id):
    cfg = load_config()
    entry = next((m for m in cfg.models if m.id == model_id), None)
    if entry is None:
        from .catalog import model_catalog
        row = next((r for r in model_catalog()['models'] if r['id'] == model_id), None)
        if not row:
            raise ValueError('Unknown model')
        entry = ModelEntry.model_validate(row['entry'])
    return cfg, entry


def presets(descriptor, *, name=None, values=None, delete=False, overwrite=False):
    path = settings_path().with_name('presets.json')
    key = descriptor['identity'] + '|' + descriptor['engine']
    with _LOCK:
        try:
            all_presets = json.loads(path.read_text())
        except FileNotFoundError:
            all_presets = {}
        bucket = all_presets.setdefault(key, {})
        if name is not None:
            name = str(name).strip()
            if not name or len(name) > 80:
                raise ValueError('Preset name must contain 1–80 characters')
            if delete:
                if name not in bucket:
                    raise ValueError('Preset does not exist')
                del bucket[name]
            else:
                if name in bucket and not overwrite:
                    raise ValueError('Preset already exists; choose Overwrite or a new name')
                bucket[name] = validate_profile(values, descriptor)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(all_presets, indent=2) + '\n')
            tmp.replace(path)
        compatible = []
        for title, settings in bucket.items():
            try:
                # Re-evaluate device-dependent controls for each saved preset.
                candidate = dict(descriptor)
                _, entry = resolve_model(descriptor['model_id'])
                candidate = describe(entry, descriptor['engine'], settings.get('runtime', {}).get('device', 'GPU'))
                validate_profile(settings, candidate)
                compatible.append({'name': title, 'values': settings})
            except ValueError:
                continue
        return {'ok': True, 'presets': compatible}


def supports_thinking(entry):
    from .catalog import _read_catalog
    rows, _, _ = _read_catalog()
    row = next((row for row in rows if isinstance(row, dict)
                and str(row.get('name', '')).split('/')[-1] == entry.id
                and str(row.get('type', '')).lower() == 'openvino'), None)
    if row is not None:
        return bool(row.get('supportsThinkingToggle'))
    # Custom exports carry their own template. Inspect data; never execute it here.
    folder = Path(entry.model_path)
    try:
        template = (folder / 'chat_template.jinja').read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        try:
            template = json.loads((folder / 'tokenizer_config.json').read_text(encoding='utf-8')).get('chat_template', '')
        except (OSError, ValueError, AttributeError):
            return False
    import re
    return isinstance(template, str) and bool(re.search(r'{%-?\s*(?:if|elif)\s+[^{}]*\benable_thinking\b', template))
