import json
import logging
from app.openvino_llm import activity


def test_loaded_does_not_claim_verified_ready():
    state = {'model_state': 'hot'}
    assert activity.snapshot(state, False, 300)['phase'] == 'loaded'
    activity.start(state)
    assert activity.snapshot(state, True, 300)['phase'] == 'waiting'
    activity.result(state, {'choices':[{'message':{'content':'OK'}}]})
    activity.finish(state)
    assert activity.snapshot(state, False, 300)['phase'] == 'ready'
    assert state['last_request']['answer_chars'] == 2


def test_reasoning_requires_actual_reasoning_text_and_is_not_answer_success():
    state = {'model_state':'hot'}
    activity.start(state)
    activity.frame(state, 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
    assert state['request_phase'] == 'waiting'
    activity.frame(state, 'data: {"choices":[{"delta":{"reasoning_content":"hmm"},"finish_reason":"length"}]}\n\n')
    assert state['request_phase'] == 'reasoning'
    activity.finish(state)
    state['model_state'] = 'cold'
    snap = activity.snapshot(state, False, 300)
    assert snap['phase'] == 'failed'
    assert 'Only reasoning' in snap['detail']
    assert snap['last_request']['finish_reason'] == 'length'


def test_error_200_persists_after_unload_and_reports_silence_honestly():
    state = {'model_state':'hot'}
    activity.start(state)
    state['request_started'] -= 180
    snap = activity.snapshot(state, True, 300)
    assert snap['phase'] == 'waiting'
    assert 'progress cannot be confirmed' in snap['detail']
    activity.frame(state, 'data: {"error":{"message":"Request timed out"}}\n\n')
    activity.finish(state)
    state['model_state']='cold'
    snap = activity.snapshot(state, False, 300)
    assert snap['phase']=='failed' and 'timed out' in snap['detail']


def test_http_200_empty_completion_is_failure_but_tool_result_is_valid():
    state = {}
    activity.start(state)
    activity.result(state, {'choices':[{'message':{'content':''}}]})
    activity.finish(state)
    assert state['last_request']['status'] == 'failed'
    activity.start(state)
    activity.frame(state, 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read"}}]}}]}\n\n')
    activity.finish(state)
    assert state['last_request']['status'] == 'completed'


def test_successful_polls_are_quiet_but_real_requests_and_errors_stay():
    quiet = activity.QuietPolls()
    def record(method,path,status):
        return logging.LogRecord('uvicorn.access',20,'',0,'%s %s %s %s %s',('client',method,path,'1.1',status),None)
    assert not quiet.filter(record('GET','/admin/status',200))
    assert quiet.filter(record('POST','/v1/chat/completions',200))
    assert quiet.filter(record('GET','/admin/status',500))
