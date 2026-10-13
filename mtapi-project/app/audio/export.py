"""Reusable, capability-driven audio export through the project's shell runner."""
from pathlib import Path
from .. import shell

FORMATS = {
    'flac': {'label': 'FLAC', 'codec': 'flac', 'extension': 'flac', 'mime': 'audio/flac', 'compression': [0, 12], 'sample_bits': [16, 24]},
    'wav': {'label': 'WAV', 'codec': 'pcm_s16le', 'extension': 'wav', 'mime': 'audio/wav', 'sample_bits': [16, 24, 32]},
    'mp3': {'label': 'MP3', 'codec': 'libmp3lame', 'extension': 'mp3', 'mime': 'audio/mpeg', 'bitrates': [64, 96, 128, 192, 256, 320]},
    'opus': {'label': 'Opus', 'codec': 'libopus', 'extension': 'opus', 'mime': 'audio/ogg', 'bitrates': [32, 64, 96, 128, 192, 256], 'sample_rates': [8000, 12000, 16000, 24000, 48000]},
    'aac': {'label': 'AAC / M4A', 'codec': 'aac', 'extension': 'm4a', 'mime': 'audio/mp4', 'bitrates': [64, 96, 128, 192, 256, 320]},
}


def export_args(source, destination, fmt, settings=None):
    if fmt not in FORMATS:
        raise ValueError('Unknown audio format')
    spec = FORMATS[fmt]
    settings = settings or {}
    allowed = {'channels', 'sample_rate', 'bitrate', 'compression', 'sample_bits'}
    if set(settings) - allowed:
        raise ValueError('Unknown audio setting')
    argv = ['ffmpeg', '-nostdin', '-v', 'error', '-n', '-i', str(Path(source).resolve()), '-vn']
    channels = int(settings.get('channels', 1))
    if channels not in (1, 2):
        raise ValueError('Channels must be mono or stereo')
    argv += ['-ac', str(channels)]
    rate = int(settings.get('sample_rate', 0))
    if rate:
        if rate not in spec.get('sample_rates', [8000, 16000, 22050, 24000, 32000, 44100, 48000]):
            raise ValueError('Unsupported sample rate for this codec')
        argv += ['-ar', str(rate)]
    elif fmt == 'opus':
        argv += ['-ar', '48000']
    codec = spec['codec']
    if 'sample_bits' in spec:
        bits = int(settings.get('sample_bits', 16))
        if bits not in spec['sample_bits']:
            raise ValueError('Unsupported sample depth')
        if fmt == 'wav':
            codec = {16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_f32le'}[bits]
        else:
            argv += ['-sample_fmt', 's16' if bits == 16 else 's32']
    elif 'sample_bits' in settings:
        raise ValueError('Sample depth is not adjustable for this codec')
    argv += ['-c:a', codec]
    if 'bitrates' in spec:
        bitrate = int(settings.get('bitrate', 128))
        if bitrate not in spec['bitrates']:
            raise ValueError('Unsupported bitrate')
        argv += ['-b:a', f'{bitrate}k']
    elif 'bitrate' in settings:
        raise ValueError('This codec has no bitrate setting')
    if fmt == 'flac':
        compression = int(settings.get('compression', 5))
        if not 0 <= compression <= 12:
            raise ValueError('FLAC compression must be 0–12')
        argv += ['-compression_level', str(compression)]
    elif 'compression' in settings:
        raise ValueError('This codec has no compression setting')
    return argv + [str(Path(destination).resolve())]


async def convert_audio(source, destination, fmt, settings=None):
    if Path(destination).exists():
        raise RuntimeError('Output already exists')
    argv = export_args(source, destination, fmt, settings)
    code, _, error = await shell.run_command(argv)
    if code or not Path(destination).is_file():
        raise RuntimeError(error.strip() or 'Audio conversion failed')
    return Path(destination)
