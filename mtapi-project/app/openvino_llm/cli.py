"""Browser-free foreground OpenVINO service and small terminal controller."""
import argparse
import asyncio
import fcntl
import json
import logging
import os
from pathlib import Path
import signal
import sys

from .config import load_config, save_config, settings_path, validate_and_merge_config


def socket_path():
    import hashlib
    key = hashlib.sha256(str(settings_path().resolve()).encode()).hexdigest()[:12]
    directory = Path(os.environ.get('XDG_RUNTIME_DIR', f'/tmp/vinoapi-{os.getuid()}')) / 'vinoapi'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_uid != os.getuid():
        raise RuntimeError('Control directory is owned by another user')
    directory.chmod(0o700)
    return directory / f'{key}.sock'


async def request(command, **values):
    try:
        reader, writer = await asyncio.open_unix_connection(str(socket_path()))
    except (FileNotFoundError, ConnectionRefusedError):
        return None
    try:
        writer.write((json.dumps({'command': command, **values}) + '\n').encode())
        await writer.drain()
        return json.loads(await asyncio.wait_for(reader.readline(), 360))
    finally:
        writer.close()
        await writer.wait_closed()


def installed_models():
    from .catalog import model_catalog
    return [row for row in model_catalog()['models'] if row.get('installed') and row.get('selectable', True)]


def select_config(model_id):
    from .profiles import resolve_model
    cfg, entry = resolve_model(model_id)
    if not any(row['id'] == model_id for row in installed_models()):
        raise ValueError('Model is not downloaded; download it in the WebUI first')
    models = [m.model_dump(mode='json') for m in cfg.models]
    if not any(m['id'] == entry.id for m in models):
        models.append(entry.model_dump(mode='json'))
    return {'active_model_id': entry.id, 'models': models,
            'runtime': {'model_path': entry.model_path}}


def display(snapshot):
    server, model = snapshot.get('server', {}), snapshot.get('model', {})
    activity = model.get('activity') or {}
    state = activity.get('phase') or model.get('state', 'unknown')
    lines = ['vinoapi · Ctrl+C stops API and releases model',
             f"API: {server.get('state', 'down')} · PID {server.get('pid') or '—'}",
             f"Address: {server.get('base_url', load_config().base_url)}",
             f"Model: {model.get('loaded_model_id') or load_config().active_model_id}",
             f"State: {state} · {model.get('device') or load_config().runtime.device} · KV {model.get('kv_cache_precision') or load_config().runtime.kv_cache_precision}"]
    if activity.get('detail'):
        lines.append(str(activity['detail']))
    lines.append(f"Available RAM: {model.get('mem_available_mb', '?')} MB · process: {model.get('process_rss_mb', '?')} MB")
    error = snapshot.get('error') or model.get('last_error') or server.get('last_error')
    if error:
        lines.append(f'Error: {error}')
    lines.append('Another terminal: vinoapi model | vinoapi status | vinoapi stop')
    # Do not allow model names or server messages to inject terminal controls.
    return '\n'.join(''.join(c if c.isprintable() else ' ' for c in line) for line in lines)


async def serve(cold=False):
    from .supervisor import OpenVinoSupervisor
    path = socket_path()
    with path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('vinoapi is already running; use vinoapi status or model')
        supervisor = OpenVinoSupervisor()
        done = asyncio.Event()
        busy = asyncio.Lock()
        handlers = set()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, done.set)

        async def handle(reader, writer):
            handlers.add(asyncio.current_task())
            try:
                payload = json.loads(await asyncio.wait_for(reader.readline(), 5))
                command = payload.get('command')
                if command == 'status':
                    result = await supervisor.status()
                    # Never send credentials or the full configuration through the controller.
                    result = {k: v for k, v in result.items() if k in ('ok', 'server', 'model', 'error')}
                elif command == 'stop':
                    done.set()
                    result = {'ok': True}
                elif command == 'model':
                    if busy.locked():
                        raise ValueError('A model operation is already in progress')
                    async with busy:
                        result = await supervisor.update_config(select_config(payload['model_id']))
                        if result.get('ok'):
                            result = await supervisor.load_model()
                        result = {'ok': result.get('ok', False), 'error': result.get('error')}
                else:
                    raise ValueError('Unknown command')
            except Exception as exc:
                result = {'ok': False, 'error': str(exc)}
            try:
                writer.write((json.dumps(result) + '\n').encode())
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                handlers.discard(asyncio.current_task())

        async def start():
            async with busy:
                result = await supervisor.start(auto_load=False, kill_stray=False)
                if not result.get('ok'):
                    raise RuntimeError(result.get('error', 'Cannot start API'))
                if not cold:
                    result = await supervisor.load_model()
                    if not result.get('ok'):
                        print(result.get('error', 'Model load failed'), file=sys.stderr)

        path.unlink(missing_ok=True)
        control = await asyncio.start_unix_server(handle, path=str(path))
        path.chmod(0o600)
        startup = asyncio.create_task(start())
        last = None
        try:
            while not done.is_set():
                if startup.done() and startup.exception():
                    raise startup.exception()
                text = display(await supervisor.status())
                if sys.stdout.isatty():
                    print('\033[H\033[J' + text, flush=True)
                elif text != last:
                    print(text, flush=True)
                last = text
                try:
                    await asyncio.wait_for(done.wait(), 2)
                except asyncio.TimeoutError:
                    pass
        finally:
            control.close()
            await control.wait_closed()
            startup.cancel()
            await asyncio.gather(startup, return_exceptions=True)
            for handler in list(handlers):
                handler.cancel()
            await asyncio.gather(*handlers, return_exceptions=True)
            if supervisor._proc is not None:
                await supervisor.stop()
            path.unlink(missing_ok=True)
            print('API stopped; model released.', flush=True)


async def main_async(args):
    if args.command in ('run', None):
        await serve(args.cold)
        return 0
    if args.command == 'model':
        rows = installed_models()
        active = load_config().active_model_id
        if not rows:
            raise ValueError('No downloaded models. Download one in the WebUI first.')
        if args.model_id:
            selected = args.model_id
        else:
            for number, row in enumerate(rows, 1):
                print(f"{number:2}. {'*' if row['id'] == active else ' '} {row['id']}")
            if not sys.stdin.isatty():
                return 0
            value = input('Choose number (Enter cancels): ').strip()
            if not value:
                return 0
            if not value.isdigit() or not 1 <= int(value) <= len(rows):
                raise ValueError('Choose a number from the list')
            selected = rows[int(value) - 1]['id']
        patch = select_config(selected)
        print(f'Selecting {selected}…', flush=True)
        result = await request('model', model_id=selected)
        if result is None:
            # A WebUI-owned worker must not silently have its settings changed.
            from .supervisor import _is_port_open
            cfg = load_config()
            if _is_port_open(cfg.host, cfg.port):
                raise ValueError('API is owned by another launcher. Stop it first or select in the WebUI.')
            save_config(validate_and_merge_config(patch))
            print('Saved for the next vinoapi run. No server started.')
        elif not result.get('ok'):
            raise ValueError(result.get('error') or 'Model switch failed')
        else:
            print('Model loaded. An answer has not yet been tested.')
        return 0
    result = await request(args.command)
    if result is None:
        print('vinoapi is not running (no terminal-owned service).')
        return 1 if args.command == 'status' else 0
    if not result.get('ok'):
        raise ValueError(result.get('error') or 'Operation failed')
    print(display(result) if args.command == 'status' else 'Stop requested.')
    return 0


def main():
    parser = argparse.ArgumentParser(prog='vinoapi', description='OpenVINO API without a browser. Ctrl+C stops everything.')
    parser.add_argument('command', nargs='?', choices=['run', 'model', 'status', 'stop'])
    parser.add_argument('model_id', nargs='?', help='Exact model ID (model command only)')
    parser.add_argument('--cold', action='store_true', help='Start API without loading weights')
    args = parser.parse_args()
    if args.model_id and args.command != 'model':
        parser.error('model ID is only valid with model')
    logging.basicConfig(level=logging.ERROR)
    try:
        return asyncio.run(main_async(args))
    except (ValueError, RuntimeError, OSError) as exc:
        print(f'vinoapi: {exc}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    sys.exit(main())
