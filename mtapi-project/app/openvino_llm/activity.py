"""Evidence-based request activity. HTTP availability is never reply success."""
import json
import logging
import time
import uuid

log = logging.getLogger('vinoapi.activity')


def event(state, phase, detail):
    if state.get('request_phase') != phase:
        log.info('request %s: %s — %s', state.get('request_id', '-'), phase, detail)
    state.update(request_phase=phase, request_detail=detail)


def start(state):
    state.update(request_id=uuid.uuid4().hex[:10], request_started=time.monotonic(),
                 answer_chars=0, reasoning_chars=0, tool_updates=0, finish_reason=None,
                 request_result=None, request_phase=None, last_reply_at=None)
    event(state, 'waiting', 'Request accepted; no model output received yet.')


def fail(state, message):
    state['request_result'] = {'status': 'failed', 'message': str(message)}
    event(state, 'failed', str(message))


def frame(state, chunk):
    text = chunk.decode(errors='replace') if isinstance(chunk, bytes) else chunk
    for line in text.splitlines():
        if not line.startswith('data: ') or line[6:] == '[DONE]':
            continue
        try:
            data = json.loads(line[6:])
        except ValueError:
            continue
        if data.get('error'):
            error = data['error']
            fail(state, error.get('message', str(error)) if isinstance(error, dict) else error)
        for choice in data.get('choices', []):
            delta = choice.get('delta') or {}
            if delta.get('reasoning_content'):
                state['reasoning_chars'] += len(delta['reasoning_content'])
                state['last_reply_at'] = time.monotonic()
                event(state, 'reasoning', 'Receiving reasoning text from the model.')
            if delta.get('content'):
                state['answer_chars'] += len(delta['content'])
                state['last_reply_at'] = time.monotonic()
                event(state, 'answering', 'Receiving answer text from the model.')
            if delta.get('tool_calls'):
                state['tool_updates'] += 1
                state['last_reply_at'] = time.monotonic()
                event(state, 'tools', 'Receiving a tool request from the model.')
            if choice.get('finish_reason'):
                state['finish_reason'] = choice['finish_reason']


def result(state, body):
    if body.get('error'):
        error = body['error']
        fail(state, error.get('message', str(error)) if isinstance(error, dict) else error)
        return
    for choice in body.get('choices', []):
        message = choice.get('message') or {}
        state['answer_chars'] += len(message.get('content') or '')
        state['reasoning_chars'] += len(message.get('reasoning_content') or '')
        state['tool_updates'] += bool(message.get('tool_calls'))
        state['finish_reason'] = choice.get('finish_reason')


def finish(state, aborted=False):
    if aborted and not state.get('request_result'):
        fail(state, 'Request ended before completion; model work was stopped.')
    if not state.get('request_result'):
        if state.get('answer_chars') or state.get('tool_updates'):
            state['request_result'] = {'status': 'completed', 'message': 'Answer received.' if state.get('answer_chars') else 'Tool request received.'}
            state['reply_verified'] = True
            event(state, 'completed', state['request_result']['message'])
        else:
            fail(state, 'Model finished without an answer.' + (' Only reasoning was returned; the reply budget may have been exhausted.' if state.get('reasoning_chars') else ' No answer or tool request was returned.'))
    state['last_request'] = {
        **state['request_result'], 'id': state.get('request_id'),
        'duration_s': round(time.monotonic() - state.get('request_started', time.monotonic()), 1),
        'answer_chars': state.get('answer_chars', 0), 'reasoning_chars': state.get('reasoning_chars', 0),
        'finish_reason': state.get('finish_reason'),
    }


def snapshot(state, active, timeout_s):
    elapsed = max(0, time.monotonic() - state.get('request_started', time.monotonic())) if active else 0
    last = state.get('last_request')
    model = state.get('model_state', 'cold')
    if model == 'loading':
        phase, detail = 'loading', 'Loading the model and preparing the device. The backend provides no reliable percentage.'
        elapsed = max(0, time.monotonic() - state.get('load_started', time.monotonic()))
    elif model == 'unloading':
        phase, detail = 'unloading', 'Releasing model memory.'
    elif active:
        phase, detail = state.get('request_phase', 'waiting'), state.get('request_detail', 'Waiting for model output; internal progress is unknown.')
        if phase == 'waiting':
            detail = f'No output received for {elapsed:.0f}s. The backend has not reported whether it is compiling, processing the prompt, or generating.'
        age = time.monotonic() - state['last_reply_at'] if state.get('last_reply_at') else elapsed
        if age >= 30 and phase not in {'failed', 'completed'}:
            detail += f' No new output for {age:.0f}s; progress cannot be confirmed. Time limit: {timeout_s:g}s.'
    elif last and last['status'] == 'failed':
        phase, detail = 'failed', last['message']
    elif state.get('last_error'):
        phase, detail = 'failed', str(state['last_error'])
    elif model == 'hot':
        phase = 'ready' if state.get('reply_verified') else 'loaded'
        detail = 'Idle. This model has returned an answer.' if phase == 'ready' else 'Weights loaded. A successful reply has not yet been verified.'
    else:
        phase, detail = 'unloaded', 'No model loaded.'
    return {'phase': phase, 'detail': detail, 'elapsed_s': round(elapsed, 1),
            'request_id': state.get('request_id') if active else None, 'input': state.get('request_summary') if active else None, 'last_request': last}


class QuietPolls(logging.Filter):
    """Hide routine successful polling, retaining real requests and all HTTP errors."""
    def filter(self, record):
        args = record.args
        if isinstance(args, tuple) and len(args) == 5:
            _, method, path, _, status = args
            if method == 'GET' and int(status) == 200 and path.split('?')[0] in {
                '/admin/status', '/internal/status', '/api/openvino/status', '/api/models/hot', '/api/activity', '/api/queue', '/health'}:
                return False
        return True
