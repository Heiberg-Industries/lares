"""LAR-98 local rehearsal: what does an agent image do at first start with a given stored definition?

Made-up data only. Needs: a local Postgres container already holding the migrated rehearsal
database (see docs/runbooks/keeper-managed-switch.md), attached to a Docker network, and an agent
runtime image already pulled. Nothing here touches any real server. Every Docker object it makes is
named with the prefix `lar98-`, and it removes what it made.

    python3 scripts/rehearsal/first-start.py --image <runtime image> --agent-json <file> \
        [--no-last-valid] [--db-container lar98-db] [--network lar98-net] [--agent chief-of-staff]

What it prints: the container's exit code (or "healthy"), the last lines of its log, and whether one
chat turn got an answer. With --no-last-valid the stored "last valid" copy of that agent's
definition is removed for the run and put back afterwards.
"""
import argparse, http.server, json, pathlib, subprocess, tempfile, threading, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--image', required=True)
ap.add_argument('--agent-json', required=True)
ap.add_argument('--agent', default='chief-of-staff')
ap.add_argument('--no-last-valid', action='store_true')
ap.add_argument('--db-container', default='lar98-db')
ap.add_argument('--network', default='lar98-net')
ap.add_argument('--db', default='lares_state')
ap.add_argument('--db-user', default='lares')
ap.add_argument('--db-password', default='lar98-made-up')
ap.add_argument('--incarnation', default='11111111-1111-4111-8111-111111111111')
ap.add_argument('--wait', type=int, default=90, help='seconds to wait for health or exit')
a = ap.parse_args()
name = 'lar98-first-start'


def run(*cmd, inp=None, check=True):
    r = subprocess.run(cmd, input=inp, text=True, capture_output=True)
    if check and r.returncode:
        raise RuntimeError(r.stdout + r.stderr)
    return r.stdout.strip()


def sql(body):
    return run('docker', 'exec', '-i', a.db_container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', a.db_user, '-d', a.db, '-Atc', body)


class Model(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *x): pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        Model.seen.append(body)
        text = 'REHEARSAL_TURN_OK'
        ev = [('message_start', {'type': 'message_start', 'message': {'id': 'm', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}}),
              ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
              ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
              ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
              ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}),
              ('message_stop', {'type': 'message_stop'})]
        if body.get('stream'):
            out = ''.join('event: %s\ndata: %s\n\n' % (k, json.dumps(d)) for k, d in ev).encode(); kind = 'text/event-stream'
        else:
            out = json.dumps({'id': 'm', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 1}}).encode(); kind = 'application/json'
        self.send_response(200); self.send_header('Content-Type', kind); self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)


server = http.server.ThreadingHTTPServer(('0.0.0.0', 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
root = pathlib.Path(tempfile.mkdtemp(prefix='lar98-first-start-')); root.chmod(0o755)
saved_row = None
try:
    (root / 'definition').mkdir(); (root / 'secrets').mkdir(); (root / 'blobs').mkdir(); (root / 'blobs').chmod(0o777)
    (root / 'definition/agent.json').write_text(pathlib.Path(a.agent_json).read_text())
    (root / 'definition/duties.md').write_text('Made-up duties.'); (root / 'definition/voice.md').write_text('Be concise.')
    for n, v in [('password', a.db_password), ('gateway', 'made-up'), ('route', 'made-up'), ('control', 'made-up')]:
        (root / 'secrets' / n).write_text(v)
    if a.no_last_valid:
        saved_row = run('docker', 'exec', a.db_container, 'pg_dump', '-U', a.db_user, '-d', a.db, '--data-only', '--inserts', '-t', 'agent_definitions')
        sql(f"DELETE FROM agent_definitions WHERE name='{a.agent}'")
    print('stored last-valid row for', a.agent, ':', sql(f"SELECT status||' '||left(hash,12) FROM agent_definitions WHERE name='{a.agent}'") or 'NONE')
    env = {'DATABASE_URL': f'postgres://{a.db_user}@{a.db_container}/{a.db}', 'WORKFLOW_POSTGRES_URL': f'postgres://{a.db_user}@{a.db_container}/{a.db}',
           'DATABASE_PASSWORD_FILE': '/secrets/password', 'GATEWAY_URL': f'http://host.docker.internal:{server.server_port}', 'GATEWAY_KEY_FILE': '/secrets/gateway',
           'EVE_SAGA_ROUTE_PASSWORD_FILE': '/secrets/route', 'LARES_AGENT_NAME': a.agent, 'LARES_DEFINITION_DIR': '/definition', 'LARES_AGENT_INCARNATION': a.incarnation,
           'LARES_RUNTIME_CONTROL_SECRET_FILE': '/secrets/control', 'AGENT_OWNER_USER_ID': 'owner', 'EVE_SCHEDULES_LIVE': '0', 'EVE_DIGEST_LIVE': '0', 'EVE_DREAM_LIVE': '0'}
    run('docker', 'rm', '-f', name, check=False)
    args = ['docker', 'run', '-d', '--platform', 'linux/amd64', '--name', name, '--network', a.network, '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:uid=10001,gid=10001,mode=1770',
            '--tmpfs', '/app/services/chief-of-staff/.eve/sandbox-cache:uid=10001,gid=10001,mode=0700,size=256m',
            '--tmpfs', '/app/services/chief-of-staff/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=384m',
            '--tmpfs', '/app/packages/agent-kit/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=64m', '-p', '127.0.0.1::3000',
            '--mount', f'type=bind,src={root}/definition,dst=/definition,readonly', '--mount', f'type=bind,src={root}/secrets,dst=/secrets,readonly',
            '--mount', f'type=bind,src={root}/blobs,dst=/app/services/chief-of-staff/.eve/.workflow-data', '--mount', f'type=bind,src={root},dst=/probe,readonly', '--add-host', 'host.docker.internal:host-gateway']
    for k, v in env.items():
        args += ['-e', f'{k}={v}']
    run(*args, a.image)
    start = time.time(); outcome = None
    while time.time() - start < a.wait:
        state = run('docker', 'inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name)
        if state.startswith('false'):
            outcome = 'EXITED with code ' + state.split()[1] + f' after {time.time() - start:.0f}s'; break
        try:
            port = run('docker', 'port', name, '3000').rsplit(':', 1)[1]
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/eve/v1/health', timeout=2) as r:
                if r.status == 200:
                    outcome = f'HEALTHY after {time.time() - start:.0f}s'; break
        except Exception:
            pass
        time.sleep(1)
    print('RESULT:', outcome or f'no answer and still running after {a.wait}s')
    if outcome and outcome.startswith('HEALTHY'):
        client = root / 'client.mjs'
        client.write_text("import {Client} from '/app/services/chief-of-staff/node_modules/eve/dist/src/client/index.js';\nconst c=new Client({host:'http://127.0.0.1:3000',auth:{basic:{username:'eve-saga',password:'made-up'}}});\nconst first=await c.sessions.create({message:'Return a short greeting.'});const r=await first.response.result();console.log(JSON.stringify({message:r.message,status:r.status}));process.exit(0);\n")
        r = subprocess.run(['docker', 'exec', name, 'node', '/probe/client.mjs'], capture_output=True, text=True, timeout=120)
        print('ONE CHAT TURN:', (r.stdout + r.stderr).strip()[:700])
        print('model calls seen:', len(Model.seen), '| tool names offered on last call:', sorted({t['name'] for t in (Model.seen[-1].get('tools', []) if Model.seen else [])})[:80])
    logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
    lines = (logs.stdout + logs.stderr).strip().splitlines()
    print('--- last log lines ---'); print('\n'.join(l[:400] for l in lines[:12])); print('...'); print('\n'.join(l[:400] for l in lines[-8:]))
    import re
    hits = [l[:300] for l in lines if re.search(r'definition|refus|unusable|error', l, re.I) and not re.search(r'legacy runs|Failed task|"error"', l)][:15]
    print('--- log lines mentioning definition/refuse/fail/error (first 15) ---'); print('\n'.join(hits))
    for i, l in enumerate(lines):
        if 'errorId' in l:
            print('--- context of the first failed chat turn ---'); print('\n'.join(x[:300] for x in lines[max(0, i - 14):i + 3])); break
    print('stored row after run:', sql(f"SELECT status||' | '||coalesce(left(status_reason,300),'') FROM agent_definitions WHERE name='{a.agent}'") or 'NONE')
finally:
    run('docker', 'rm', '-f', name, check=False)
    server.shutdown()
    if saved_row:
        run('docker', 'exec', '-i', a.db_container, 'psql', '-X', '-q', '-U', a.db_user, '-d', a.db, inp=saved_row.replace('INSERT INTO public.agent_definitions', 'INSERT INTO public.agent_definitions'), check=False)
        print('last-valid rows restored:', sql("SELECT string_agg(name,',') FROM agent_definitions"))
