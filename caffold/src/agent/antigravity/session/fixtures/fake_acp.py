#!/usr/bin/env python3
"""ACP wire fixture, not a model or native-record simulator."""
import json
import os
import sys
import threading
import time

lock = threading.Lock()
pending = None
started = False
behavior = os.environ.get('ACP_FIXTURE_BEHAVIOR', 'pending')
native = '63910fa2-b1ed-4e64-87b8-b9928c1d7015'
options = [
    {'id': 'model', 'currentValue': 'fixture', 'options': [{'value': 'fixture', 'name': 'Fixture'}]},
    {'id': 'thinking_level', 'currentValue': 'low', 'options': [{'value': 'low', 'name': 'Low'}]},
    {'id': 'mode', 'currentValue': 'default', 'options': [{'value': 'default', 'name': 'Default'}]},
]

def emit(value):
    with lock:
        print(json.dumps(value), flush=True)

def log(value):
    with lock:
        with open(os.environ['ACP_FIXTURE_LOG'], 'a') as f:
            f.write(json.dumps(value) + '\n')

def context(used):
    if behavior.startswith('context'):
        emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
            'sessionId': native,
            'update': {'sessionUpdate': 'usage_update', 'used': used, 'size': 64000}}})

def finish():
    global pending
    if pending is not None:
        current, pending = pending, None
        context(2400)
        emit({'jsonrpc': '2.0', 'id': current, 'result': {'stopReason': 'end_turn'}})
        log({'finished': current})

def gate():
    while True:
        if os.path.exists(os.environ['ACP_FIXTURE_FINISH']):
            finish()
            return
        time.sleep(.01)

log({'pid': os.getpid()})
for line in sys.stdin:
    frame = json.loads(line)
    log(frame)
    method = frame.get('method')
    if method == 'initialize':
        result = {'protocolVersion': 1, 'agentInfo': {'version': '1.4.5'}, 'authMethods': [{'id': 'oauth-personal'}]}
    elif method == 'authenticate':
        if os.environ.get('ACP_FIXTURE_BEHAVIOR') == 'auth-required':
            print('https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F&state=fixture-state', file=sys.stderr, flush=True)
            continue
        if os.environ.get('ACP_FIXTURE_BEHAVIOR') == 'auth-network-error':
            emit({'jsonrpc': '2.0', 'id': frame['id'], 'error': {'code': -32603, 'message': 'network unavailable'}})
            continue
        result = {}
    elif method == 'session/new':
        context(0)
        if behavior == 'context-invalid':
            for values in [{'used': 1200, 'size': 0}, {'size': 64000}, {'used': -1, 'size': 64000}]:
                emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
                    'sessionId': native, 'update': {'sessionUpdate': 'usage_update', **values}}})
        result = {'sessionId': native, 'configOptions': options}
    elif method == 'session/load':
        context(900)
        result = {'configOptions': options}
    elif method == 'session/set_config_option':
        for option in options:
            if option['id'] == frame['params']['configId']:
                option['currentValue'] = frame['params']['value']
        result = {'configOptions': options}
    elif method == 'session/prompt':
        pending = frame['id']
        context(1200)
        if behavior != 'startup':
            started = True
            emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': native, 'update': {'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': 'fixture started'}}}})
        else:
            def startup():
                global started
                while not os.path.exists(os.environ['ACP_FIXTURE_FINISH'] + '.start'):
                    time.sleep(.01)
                started = True
                emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': native, 'update': {'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': 'fixture started'}}}})
            threading.Thread(target=startup, daemon=True).start()
        if behavior in ('immediate', 'context'):
            finish()
        elif behavior in ('gated', 'context-gated'):
            threading.Thread(target=gate, daemon=True).start()
        elif behavior in ('permission', 'question'):
            emit({'jsonrpc': '2.0', 'id': 991, 'method': 'session/request_permission', 'params': {
                'sessionId': native, 'toolCall': {'toolCallId': 'interaction_0123abcd' if behavior == 'question' else 'wire-control-only', 'title': 'Fixture permission', 'kind': 'execute', 'rawInput': {'CommandLine': 'pwd'}},
                'options': [{'optionId': 'allow', 'kind': 'allow_once', 'name': 'Allow'}, {'optionId': 'deny', 'kind': 'reject_once', 'name': 'Deny'}]}})
        continue
    elif method == 'session/cancel':
        if started:
            finish()
        else:
            log({'cancel_ignored_before_start': True})
        continue
    elif method is None and frame.get('id') == 991:
        finish()
        continue
    else:
        result = {}
    emit({'jsonrpc': '2.0', 'id': frame['id'], 'result': result})
