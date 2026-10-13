"""Local TTS catalog, staged installer, synthesis jobs and temporary playback."""
from fastapi import FastAPI
from fastapi.responses import FileResponse
from ..audio import tts


def register(app: FastAPI):
    # Previews do not survive API restarts; remove orphaned scratch files.
    if tts.PREVIEW_ROOT.exists():
        for path in tts.PREVIEW_ROOT.iterdir():
            if path.is_file():
                path.unlink(missing_ok=True)
    @app.get('/api/tts/status')
    async def status():
        return tts.catalog()

    @app.post('/api/tts/install')
    async def install(payload: dict):
        if not isinstance(payload.get('model'), str) or payload['model'] not in tts.RECIPES:
            return {'ok': False, 'error': 'Unknown TTS model'}
        try:
            recipe = tts.selected_recipe(payload)
            tts.validate_controls(recipe['engine'], payload.get('controls'))
        except ValueError as error:
            return {'ok': False, 'error': str(error)}
        return tts.begin('install', payload)

    @app.post('/api/tts/generate')
    async def generate(payload: dict):
        if not isinstance(payload.get('model'), str) or payload['model'] not in tts.RECIPES:
            return {'ok': False, 'error': 'Unknown TTS model'}
        if not isinstance(payload.get('text'), str) or not payload['text'].strip() or len(payload['text']) > 10000:
            return {'ok': False, 'error': 'Enter 1–10,000 characters of text'}
        if not isinstance(payload.get('format', 'flac'), str) or payload.get('format', 'flac') not in tts.FORMATS or not isinstance(payload.get('settings', {}), dict):
            return {'ok': False, 'error': 'Invalid audio export settings'}
        if not isinstance(payload.get('save_audio', True), bool) or not isinstance(payload.get('output_path', ''), str):
            return {'ok': False, 'error': 'Invalid save option or output path'}
        try:
            recipe = tts.selected_recipe(payload)
            tts.validate_controls(recipe['engine'], payload.get('controls'))
        except ValueError as error:
            return {'ok': False, 'error': str(error)}
        return tts.begin('generate', payload)

    @app.get('/api/tts/job/{token}')
    async def job(token: str):
        return tts.job_status(token)

    @app.get('/api/tts/preview/{token}')
    async def preview(token: str):
        tts.cleanup_previews()
        item = tts.PREVIEWS.get(token)
        if not item or not item['path'].is_file():
            return {'ok': False, 'error': 'Preview expired'}
        return FileResponse(item['path'], media_type=item['mime'])

    @app.delete('/api/tts/preview/{token}')
    async def release(token: str):
        item = tts.PREVIEWS.pop(token, None)
        if item:
            item['path'].unlink(missing_ok=True)
        return {'ok': True}
