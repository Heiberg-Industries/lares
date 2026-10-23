"""Real proxy-image policy/reload proof, run only in disposable Linux CI.

All clients and destinations use an internal Docker network. No published ports,
credentials, providers, installation state or host Docker socket mounts.
"""
import base64
import ipaddress
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Run proxy image proof only in CI'
assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
image, client_image, output = sys.argv[1:]
root = pathlib.Path(tempfile.mkdtemp(prefix='lares-proxy-proof-'))
root.chmod(0o755)
name = 'lares-proxy-proof-' + uuid.uuid4().hex[:10]
proxy, target = name + '-proxy', name + '-target'
report = {'source': os.environ['GITHUB_SHA'], 'checks': [], 'success': False}


def cmd(*args, input=None):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        raise RuntimeError(f'{args[:3]} failed: {result.stdout}{result.stderr}')
    return result.stdout.strip()


def check(label, condition):
    assert condition, label
    report['checks'].append(label)
    print('PASS:', label, flush=True)


def generate(host, stage):
    # Exercise the real generator; only this disposable fixture appends the
    # candidate generation marker. Publish policy and marker atomically together.
    script = """import('/app/services/keeper/lib/egress.ts').then(({generateEgress})=>{
      const fs=require('node:fs');
      const config=generateEgress([{name:'client',address:ADDRESS,grants:[],infrastructureHosts:[HOST]}]);
      const fixture=config.squid+'\\nreply_header_add X-Lares-Route-Stage '+STAGE+' all\\n';
      fs.writeFileSync('/output/squid.next',fixture);
      fs.renameSync('/output/squid.next','/output/squid.conf');
    })""".replace('ADDRESS', json.dumps(allowed_ip)).replace('HOST', json.dumps(host)).replace(
        'STAGE', json.dumps(stage))
    cmd('docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', f'{os.getuid()}:{os.getgid()}',
        '--mount', f'type=bind,src={root},dst=/output', '--entrypoint',
        '/app/services/keeper/node_modules/.bin/tsx', client_image, '-e', script)


RESPONSE_PARSER = r"""function parseResponse(data,error){
  const headerEnd=data.indexOf(Buffer.from('\r\n\r\n'));
  const headerLines=headerEnd<0?[]:data.subarray(0,headerEnd).toString('latin1').split('\r\n');
  const statusMatch=(headerLines[0]||'').match(/^HTTP\/\d+\.\d+ ([0-9]{3})(?:[ \t]|$)/);
  const routeStageValues=[];let routeStageMalformed=false;
  const trimOws=value=>value.replace(/^[ \t]+|[ \t]+$/g,'');
  const control=/[\x00-\x08\x0a-\x1f\x7f]/;
  for(const line of headerLines.slice(1)){
    if(control.test(line))routeStageMalformed=true;
    if(/^[ \t]/.test(line)){routeStageMalformed=true;continue;}
    const colon=line.indexOf(':');
    if(colon<0){
      if(/^x-lares-route-stage(?:[: \t]|$)/i.test(trimOws(line)))routeStageMalformed=true;
      continue;
    }
    const rawName=line.slice(0,colon);
    const name=trimOws(rawName);
    const isStage=/^x-lares-route-stage$/i.test(name);
    if(isStage){
      if(rawName!==name)routeStageMalformed=true;
      const value=line.slice(colon+1);
      if(control.test(value))routeStageMalformed=true;
      routeStageValues.push(trimOws(value));
    }else if(/^x-lares-route-stage(?:[ \t]|$)/i.test(name)){
      routeStageMalformed=true;
    }
  }
  return {status:statusMatch?Number(statusMatch[1]):null,
    greeting:data.includes(Buffer.from('CI_PROXY_DESTINATION_OK')),
    route_stage_values:routeStageValues,route_stage_malformed:routeStageMalformed,
    error:error||null};
}"""


def request(payload, source=None):
    # The same strict parser handles raw fixture cases and real proxy responses.
    script = r"""const net=require('node:net');
      __RESPONSE_PARSER__
      const s=net.createConnection({host:__PROXY_ADDRESS__,port:8888});
      let data=Buffer.alloc(0),done=false,absoluteTimer;
      function finish(error){
        if(done)return;
        done=true;
        clearTimeout(absoluteTimer);
        try{console.log(JSON.stringify(parseResponse(data,error)));}
        finally{s.destroy();}
      }
      absoluteTimer=setTimeout(()=>finish('absolute-timeout'),5000);
      s.on('connect',()=>s.write(Buffer.from(__PAYLOAD_BASE64__,'base64')));
      s.on('data',chunk=>{data=Buffer.concat([data,chunk]);
        if(data.length>65536)return finish('oversized');
        if(data.includes(Buffer.from('\r\n\r\n'))){
          if(!/^HTTP\/\d\.\d 200/.test(data.toString())||data.includes(Buffer.from('CI_PROXY_DESTINATION_OK')))finish();}});
      s.on('error',e=>finish(e.code));s.on('end',()=>finish());
      s.setTimeout(5000,()=>finish('inactivity-timeout'));
    """.replace('__RESPONSE_PARSER__', RESPONSE_PARSER).replace(
        '__PROXY_ADDRESS__', json.dumps(proxy_ip)).replace('__PAYLOAD_BASE64__', json.dumps(
        base64.b64encode(payload.encode()).decode()))
    result = json.loads(cmd('docker', 'run', '--rm', '--network', name, '--ip', source or allowed_ip,
                         '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                         '--entrypoint', 'node', client_image, '-e', script))
    report['last_response'] = result
    return result


def connect(host='allowed.example', port=443):
    return f'CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'


def target_connections():
    return cmd('docker', 'logs', target).count('DESTINATION_ACCEPTED')


def route_stage_acknowledged(response, expected_stage):
    valid_stage = re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
        expected_stage or '')
    return bool(valid_stage) and response.get('status') == 403 and not response.get('greeting') and (
        response.get('error') is None and not response.get('route_stage_malformed', True)
        and response.get('route_stage_values') == [expected_stage])


def check_raw_response_parser(client_image):
    stage = '11111111-1111-4111-8111-111111111111'
    crlf = chr(13) + chr(10)
    cases = [
        ('valid raw marker', crlf.join(['HTTP/1.1 403 Forbidden',
          f'X-Lares-Route-Stage: {stage}', '', '']), True),
        ('missing raw marker', crlf.join(['HTTP/1.1 403 Forbidden', 'Other: value', '', '']), False),
        ('duplicate raw markers', crlf.join(['HTTP/1.1 403 Forbidden',
          f'X-Lares-Route-Stage: {stage}', f'X-Lares-Route-Stage: {stage}', '', '']), False),
        ('folded hidden duplicate after another header', crlf.join(['HTTP/1.1 403 Forbidden',
          f'X-Lares-Route-Stage: {stage}', 'Other: value', ' X-Lares-Route-Stage: stale', '', '']), False),
        ('vertical-tab-prefixed marker value', crlf.join(['HTTP/1.1 403 Forbidden',
          'X-Lares-Route-Stage: ' + chr(11) + stage, '', '']), False),
        ('malformed four-digit status', crlf.join(['HTTP/1.1 4030 Forbidden',
          f'X-Lares-Route-Stage: {stage}', '', '']), False),
    ]
    raw = [{'name': name, 'raw': response} for name, response, _expected in cases]
    script = RESPONSE_PARSER + '\nconst cases=' + json.dumps(raw) + ';\n' + (
        "console.log(JSON.stringify(cases.map(item=>parseResponse(Buffer.from(item.raw,'latin1'),null))));")
    responses = json.loads(cmd('docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
                               '--security-opt', 'no-new-privileges:true', '--entrypoint', 'node',
                               client_image, '-e', script))
    if len(responses) != len(cases):
        raise RuntimeError('raw response parser returned an unexpected case count')
    report['raw_parser_cases'] = {}
    for (name, _raw_response, expected), response in zip(cases, responses):
        accepted = route_stage_acknowledged(response, stage)
        check('Raw response parser ' + name, accepted is expected)
        report['raw_parser_cases'][name] = {
            'accepted': accepted,
            'expected': expected,
            'status': response['status'],
            'route_stage_values': response['route_stage_values'],
            'route_stage_malformed': response['route_stage_malformed'],
        }


def proxy_pid():
    return cmd('docker', 'exec', proxy, 'sh', '-c',
               'for p in /run/squid.pid /run/squid/squid.pid; do '
               'if [ -f "$p" ]; then cat "$p"; exit; fi; done; exit 1')


try:
    report['image_id'] = cmd('docker', 'image', 'inspect', image, '--format', '{{.Id}}')
    report['client_image_id'] = cmd('docker', 'image', 'inspect', client_image, '--format', '{{.Id}}')
    # The server-only storage CLI must resolve its workspace exports as the fixed runtime uid.
    storage_help = cmd('docker', 'run', '--rm', '--network', 'none', '--read-only',
                       '--user', '10001:10001', '--cap-drop', 'ALL',
                       '--security-opt', 'no-new-privileges:true',
                       '--tmpfs', '/tmp:uid=10001,gid=10001,mode=1770',
                       '--entrypoint', '/app/services/box/node_modules/.bin/tsx',
                       client_image, '/app/services/box/bin/vault-storage.ts', '--help')
    check('Vault storage CLI resolves server exports as runtime user without a database',
          'vault-storage preview|apply|' in storage_help)
    report['squid_version'] = cmd('docker', 'run', '--rm', '--network', 'none',
                                '--entrypoint', 'squid', image, '-v')
    version = re.search(r'Version (\d+)\.(\d+)', report['squid_version'])
    check('Squid includes the 7.6 HTTP framing fix', version and tuple(map(int, version.groups())) >= (7, 6))
    check_raw_response_parser(client_image)
    cmd('docker', 'network', 'create', '--internal', name)
    config = json.loads(cmd('docker', 'network', 'inspect', name, '--format', '{{json .IPAM.Config}}'))
    subnet = ipaddress.ip_network(config[0]['Subnet'])
    # Docker permits fixed client addresses only on an explicitly configured
    # subnet. Reuse its free selection rather than assuming a shared CI range.
    cmd('docker', 'network', 'rm', name)
    cmd('docker', 'network', 'create', '--internal', '--subnet', str(subnet), name)
    allowed_ip, denied_ip, target_ip, proxy_ip = [str(subnet.network_address + n) for n in (10, 11, 12, 13)]
    initial_stage, desired_stage, restored_stage = (str(uuid.uuid4()) for _ in range(3))
    report['fixture_route_stages'] = {
        'initial': initial_stage, 'desired_before_reload': desired_stage, 'restored': restored_stage,
    }
    endpoint = """const net=require('node:net');
      for(const port of [443,444])net.createServer(s=>{
        console.log('DESTINATION_ACCEPTED',port);s.end('CI_PROXY_DESTINATION_OK\\n');
      }).listen(port,'0.0.0.0',()=>console.log('DESTINATION_READY',port));"""
    cmd('docker', 'run', '-d', '--name', target, '--network', name, '--ip', target_ip,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--entrypoint', 'node', client_image, '-e', endpoint)
    generate('allowed.example', initial_stage)
    conf = (root / 'squid.conf').read_text()
    check('Generated config disables caching and enables no ICP or collapsed forwarding',
          'cache deny all' in conf and not re.search(r'^(icp_port|collapsed_forwarding|include)\b', conf, re.M))
    cmd('docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges:true',
        '--mount', f'type=bind,src={root},dst=/config,readonly',
        '--entrypoint', 'squid', image, '-k', 'parse', '-f', '/config/squid.conf')
    cmd('docker', 'run', '-d', '--init', '--name', proxy, '--network', name, '--ip', proxy_ip,
        '--add-host', f'allowed.example:{target_ip}', '--add-host', f'blocked.example:{target_ip}',
        '--mount', f'type=bind,src={root},dst=/config,readonly', image,
        'squid', '-N', '-f', '/config/squid.conf')
    for attempt in range(30):
        result = request(connect())
        if result['status'] == 200 and result['greeting']:
            break
        if cmd('docker', 'inspect', proxy, '--format', '{{.State.Running}}') != 'true':
            raise RuntimeError(cmd('docker', 'logs', proxy))
        time.sleep(.5)
    check('Real allowed CONNECT reaches the isolated destination', result['status'] == 200 and result['greeting'])
    pid = proxy_pid()
    check('Squid PID is behind Docker init and reloadable', pid.isdigit() and int(pid) > 1)
    before = target_connections()
    denied = [('ungranted destination', connect('blocked.example'), allowed_ip, (403,)),
              ('ungranted source', connect(), denied_ip, (403,)),
              ('ungranted port', connect(port=444), allowed_ip, (403,)),
              ('non-CONNECT method', 'GET http://allowed.example:443/ HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n', allowed_ip, (403,)),
              ('conflicting HTTP framing', 'POST http://blocked.example/ HTTP/1.1\r\nHost: blocked.example\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n0\r\n\r\n', allowed_ip, (400, 403)),
              # 501 is a parser's unsupported transfer-coding refusal; a generic
              # upstream error such as 502/503 is never evidence of policy refusal.
              ('invalid Transfer-Encoding', 'GET http://blocked.example/ HTTP/1.1\r\nHost: blocked.example\r\nTransfer-Encoding: chunked, identity\r\n\r\n0\r\n\r\n', allowed_ip, (400, 403, 501))]
    for label, payload, source, statuses in denied:
        result = request(payload, source)
        check('Proxy refuses ' + label, result['status'] in statuses and not result['greeting'])
    check('Refused and malformed requests never reach the dummy destination', target_connections() == before)
    generate('blocked.example', desired_stage)
    route_host = 'route-proof-' + uuid.uuid4().hex + '.invalid'
    before_stale_probe_target_count = target_connections()
    stale_route_response = request(connect(route_host))
    after_stale_probe_target_count = target_connections()
    check('Denied CONNECT reports the actual pre-reload Squid generation',
          route_stage_acknowledged(stale_route_response, initial_stage))
    check('Unreloaded desired generation is rejected as stale',
          not route_stage_acknowledged(stale_route_response, desired_stage))
    check('Pre-reload denied generation probe adds zero target connections',
          after_stale_probe_target_count == before_stale_probe_target_count)
    check('Acknowledgement validation rejects a missing stage marker',
          not route_stage_acknowledged(dict(stale_route_response, route_stage_values=[]), initial_stage))
    check('Acknowledgement validation rejects duplicate stage markers',
          not route_stage_acknowledged(dict(stale_route_response,
                                            route_stage_values=[initial_stage, initial_stage]), initial_stage))
    check('Acknowledgement validation rejects a malformed stage value',
          not route_stage_acknowledged(dict(stale_route_response,
                                            route_stage_values=['not-a-generation']), initial_stage))
    check('Acknowledgement validation rejects a malformed stage header',
          not route_stage_acknowledged(dict(stale_route_response, route_stage_malformed=True), initial_stage))
    cmd('docker', 'exec', proxy, 'squid', '-k', 'reconfigure', '-f', '/config/squid.conf')
    for attempt in range(30):
        result = request(connect('blocked.example'))
        if result['status'] == 200 and result['greeting']:
            break
        time.sleep(.5)
    check('Atomic config replacement is applied by real reload', result['status'] == 200 and result['greeting'])
    before_reloaded_probe_target_count = target_connections()
    reloaded_route_response = request(connect(route_host))
    after_reloaded_probe_target_count = target_connections()
    check('Denied CONNECT reports the exact reloaded Squid generation',
          route_stage_acknowledged(reloaded_route_response, desired_stage))
    check('Reloaded denied generation probe adds zero target connections',
          after_reloaded_probe_target_count == before_reloaded_probe_target_count)
    report['route_generation_proof'] = {
        'host': route_host,
        'before_reload': stale_route_response,
        'expected_before_reload': initial_stage,
        'desired_before_reload': desired_stage,
        'after_reload': reloaded_route_response,
        'expected_after_reload': desired_stage,
        'target_connections_before_reload_probe': before_stale_probe_target_count,
        'target_connections_after_reload_probe': before_reloaded_probe_target_count,
        'target_connection_delta_before_reload': after_stale_probe_target_count - before_stale_probe_target_count,
        'target_connection_delta_after_reload': after_reloaded_probe_target_count - before_reloaded_probe_target_count,
        'marker_is_fixture_augmentation': True,
    }
    result = request(connect())
    check('Reload revokes the previous destination', result['status'] == 403 and not result['greeting'])
    check('Reload preserves the running Squid process', proxy_pid() == pid)
    generate('allowed.example', restored_stage)
    cmd('docker', 'exec', proxy, 'squid', '-k', 'reconfigure', '-f', '/config/squid.conf')
    for attempt in range(30):
        result = request(connect())
        if result['status'] == 200 and result['greeting']:
            break
        time.sleep(.5)
    check('Reload can restore the original grant', result['status'] == 200 and result['greeting'])
    # Squid may listen on DNS UDP sockets; only the ICP/HTCP ports are excluded.
    sockets = cmd('docker', 'exec', proxy, 'sh', '-c', 'cat /proc/net/udp /proc/net/udp6')
    check('ICP and HTCP have no UDP listener', not re.search(r':(?:0C3A|12DB)\s', sockets))
    report['success'] = True
except Exception as error:
    report['error'] = str(error)
    for container in (proxy, target):
        subprocess.run(['docker', 'logs', '--tail', '50', container], check=False, timeout=10)
    raise
finally:
    pathlib.Path(output).write_text(json.dumps(report, indent=2) + '\n')
    for container in (proxy, target):
        subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False, timeout=30)
    subprocess.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=False, timeout=30)
    shutil.rmtree(root)
