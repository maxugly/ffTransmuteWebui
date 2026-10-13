"""Synthesis capabilities for the pinned local runtimes, shared by API and worker."""
import math


def number(key, label, default, lo, hi, step=.05, help='', advanced=False):
    return dict(id=key, label=label, type='number', default=default, min=lo, max=hi,
                step=step, help=help, advanced=advanced)


def flag(key, label, default, help='', advanced=False):
    return dict(id=key, label=label, type='boolean', default=default, help=help, advanced=advanced)


def choice(key, label, default, options, help='', advanced=False):
    return dict(id=key, label=label, type='select', default=default,
                options=[dict(id=k, label=v) for k,v in options], help=help, advanced=advanced)


LANGUAGES = [('en','English'),('ko','Korean'),('ja','Japanese'),('ar','Arabic'),('bg','Bulgarian'),
 ('cs','Czech'),('da','Danish'),('de','German'),('el','Greek'),('es','Spanish'),('et','Estonian'),
 ('fi','Finnish'),('fr','French'),('hi','Hindi'),('hr','Croatian'),('hu','Hungarian'),('id','Indonesian'),
 ('it','Italian'),('lt','Lithuanian'),('lv','Latvian'),('nl','Dutch'),('pl','Polish'),('pt','Portuguese'),
 ('ro','Romanian'),('ru','Russian'),('sk','Slovak'),('sl','Slovenian'),('sv','Swedish'),('tr','Turkish'),
 ('uk','Ukrainian'),('vi','Vietnamese'),('na','Unknown language fallback')]
CAPABILITIES = {
 'piper': [number('speed','Speed ×',1,.5,2,help='1 = normal; higher = faster. Scales the selected voice’s native phoneme duration.'),
   number('volume','Volume ×',1,0,2,help='Native output gain. Above 1 may clip.'),
   flag('normalize_audio','Normalize loudness',True,'Normalize each sentence before applying volume.'),
   number('noise_scale','Audio variation',None,0,2,help='Generator noise; blank keeps this voice’s trained default. This is not an emotion preset.',advanced=True),
   number('noise_w_scale','Speaking variation',None,0,2,help='Duration variation; blank keeps the voice default.',advanced=True)],
 'kokoro': [number('speed','Speed ×',1,.5,2,help='Native synthesis speed; 1 = normal.'),
   number('sentence_pause','Sentence pause (s)',.25,0,5,help='Pause after sentence punctuation; placement depends on model timing support.'),
   number('clause_pause','Clause pause (s)',.1,0,5,help='Pause after clause punctuation.'),
   choice('language','Pronunciation','auto',[('auto','Follow voice (US / UK)'),('en-us','English US'),('en-gb','English UK')],'Select the English phonemizer accent.'),
   flag('trim','Trim silence',True,'Trim native silence at batch boundaries.',True),
   flag('is_phonemes','Input is phonemes',False,'Treat your text as model phonemes, bypassing ordinary text pronunciation.',True)],
 'supertonic': [number('speed','Speed ×',1.05,.5,2,help='Native speaking speed; upstream default 1.05.'),
   choice('language','Language','en',LANGUAGES,'Explicit pronunciation language; fallback is not automatic language detection.'),
   number('silence_duration','Chunk pause (s)',.3,0,5,help='Silence between text chunks.'),
   number('total_steps','Custom steps',0,0,100,1,'0 follows the quality preset; 1–100 overrides it. More steps cost more compute.',True),
   number('max_chunk_length','Chunk characters',0,0,1000,1,'0 uses the runtime language default (300, Korean 120). Positive values control text chunk size.',True)],
 'kitten': [number('speed','Speed ×',1,.5,2,help='Native synthesis speed; each voice’s speed prior is retained.'),
   flag('clean_text','Normalize text',True,'Expand numbers, currencies and abbreviations using the runtime’s text cleaner.')],
 'dectalk': [number('rate','Rate (words/min)',180,75,600,1,'Native speaking rate.'),
   number('comma','Comma pause Δ (ms)',0,-40,30000,1,'Offset from the native comma pause; 0 restores its default.'),
   number('period','Sentence pause Δ (ms)',0,-380,30000,1,'Offset from the native sentence pause; 0 restores its default.'),
   choice('punctuation','Read punctuation','some',[(x,x.title()) for x in ['none','some','all','pass']],'Native punctuation handling.')],
}
# Documented Design Voice parameters; bounds from the installed engine’s limit table.
DV = [
 ('ap','Average pitch (Hz)',50,350),('pr','Pitch range (%)',0,250),('as','Assertiveness (%)',0,200),
 ('br','Breathiness (dB)',0,72),('ri','Richness (%)',0,100),('sm','Smoothness (%)',0,100),
 ('hs','Head size (%)',65,145),('la','Creakiness (%)',0,100),('lx','Lax breathiness (%)',0,100),
 ('qu','Pitch quickness (%)',0,100),('bf','Baseline fall (Hz)',0,90),('hr','Phrase rise (Hz)',2,100),
 ('sr','Stress rise (Hz)',1,100),('ft','Pitch-dependent tilt (%)',0,100),
 ('f7','Parallel fourth formant (Hz)',2500,6000),
('nf','Fixed glottal samples',0,100),
 ('f4','Fourth formant (Hz)',2000,6000),('f5','Fifth formant (Hz)',2500,6000),
 ('b4','Fourth bandwidth (Hz)',100,6000),('b5','Fifth bandwidth (Hz)',100,6000),
 ('gf','Frication gain (dB)',0,87),('gh','Aspiration gain (dB)',0,87),('gv','Voicing gain (dB)',0,87),
 ('gn','Nasal gain (dB)',0,87),('g1','Resonator 1 gain (dB)',0,87),('g2','Resonator 2 gain (dB)',0,87),
 ('g3','Resonator 3 gain (dB)',0,87),('g4','Resonator 4 gain (dB)',0,87),('g5','Voice loudness (dB)',0,87)]
for key,label,lo,hi in DV:
    CAPABILITIES['dectalk'].append(number('dv_'+key,label,None,lo,hi,1,
      'Blank retains the selected voice’s default. Native Design Voice '+key+'.'+
      (' Formant frequencies interact with head size and sex; use small changes.' if key in ('f4','f5','hs') else ''),True))
CAPABILITIES['dectalk'].append(choice('dv_sx','Voice tract','auto',
    [('auto','Voice default'),('0','Female tract'),('1','Male tract')],
    'Changes the native vocal tract table, independently of pitch.',True))


def validate_controls(engine, values=None):
    if values is None:
        values = {}
    if not isinstance(values, dict):
        raise ValueError('Model controls must be an object')
    fields = {c['id']:c for c in CAPABILITIES[engine]}
    if values.keys() - fields.keys():
        raise ValueError('Unsupported controls for this model: '+', '.join(sorted(values.keys()-fields.keys())))
    result = {}
    for key, c in fields.items():
        value = values.get(key,c['default'])
        if value is None and c['default'] is None:
            result[key] = None
            continue
        if c['type'] == 'boolean':
            valid = isinstance(value,bool)
        elif c['type'] == 'select':
            valid = isinstance(value,str) and value in {o['id'] for o in c['options']}
        else:
            valid = isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and c['min']<=value<=c['max']
            if valid and c['step']==1:
                valid = int(value)==value
                if valid:value=int(value)
        if not valid:
            raise ValueError('Invalid '+c['label']+' for this model')
        result[key] = value
    if engine == 'dectalk' and result['dv_f4'] is not None and result['dv_f5'] is not None and result['dv_f4'] < 6000 and result['dv_f5'] < 6000 and result['dv_f5'] < result['dv_f4']+300:
        raise ValueError('Fifth formant must be at least 300 Hz above fourth formant')
    return result


def dectalk_commands(controls):
    commands = ''.join(f'[:{key} {controls[key]}]' for key in ('rate','comma','period'))
    commands += '[:punct '+controls['punctuation']+']'
    pairs = [f'{key[3:]} {value}' for key,value in controls.items() if key.startswith('dv_') and value is not None and value != 'auto']
    if pairs:commands += '[:dv '+' '.join(pairs)+']'
    return commands
