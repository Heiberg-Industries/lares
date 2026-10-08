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


def generate(host):
    # Exercise the real generator; atomic replacement must remain visible through
    # the directory bind mount used by the installation's existing compose file.
    script = """import('/app/services/keeper/lib/egress.ts').then(({generateEgress})=>{
      const fs=require('node:fs');
      const config=generateEgress([{name:'client',address:ADDRESS,grants:[],infrastructureHosts:[HOST]}]);
      fs.writeFileSync('/output/squid.next',config.squid);
      fs.renameSync('/output/squid.next','/output/squid.conf');
    })""".replace('ADDRESS', json.dumps(allowed_ip)).replace('HOST', json.dumps(host))
    cmd('docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', f'{os.getuid()}:{os.getgid()}',
        '--mount', f'type=bind,src={root},dst=/output', '--entrypoint',
        '/app/services/keeper/node_modules/.bin/tsx', client_image, '-e', script)


def request(payload, source=None):
    # Wait for a complete header and the dummy destination's greeting for 200.
    # A non-200 response is enough to prove refusal; errors/timeouts fail callers.
    script = r"""const net=require('node:net');
      const s=net.createConnection({host:PROXY,port:8888});let data=Buffer.alloc(0),done=false;
      function finish(error){if(done)return;done=true;
        const match=data.toString().match(/^HTTP\/\d\.\d (\d+)/);
        console.log(JSON.stringify({status:match?Number(match[1]):null,
          greeting:data.includes(Buffer.from('CI_PROXY_DESTINATION_OK')),error:error||null}));s.destroy();}
      s.on('connect',()=>s.write(Buffer.from(PAYLOAD,'base64')));
      s.on('data',chunk=>{data=Buffer.concat([data,chunk]);
        if(data.length>65536)return finish('oversized');
        if(data.includes(Buffer.from('\r\n\r\n'))){
          if(!/^HTTP\/\d\.\d 200/.test(data.toString())||data.includes(Buffer.from('CI_PROXY_DESTINATION_OK')))finish();}});
      s.on('error',e=>finish(e.code));s.on('end',()=>finish());
      s.setTimeout(5000,()=>finish('timeout'));
    """.replace('PROXY', json.dumps(proxy_ip)).replace('PAYLOAD', json.dumps(
        base64.b64encode(payload.encode()).decode()))
    return json.loads(cmd('docker', 'run', '--rm', '--network', name, '--ip', source or allowed_ip,
                         '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                         '--entrypoint', 'node', client_image, '-e', script))


def connect(host='allowed.example', port=443):
    return f'CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'


def target_connections():
    return cmd('docker', 'logs', target).count('DESTINATION_ACCEPTED')


def proxy_pid():
    return cmd('docker', 'exec', proxy, 'sh', '-c',
               'for p in /run/squid.pid /run/squid/squid.pid; do '
               'if [ -f "$p" ]; then cat "$p"; exit; fi; done; exit 1')


try:
    report['image_id'] = cmd('docker', 'image', 'inspect', image, '--format', '{{.Id}}')
    report['client_image_id'] = cmd('docker', 'image', 'inspect', client_image, '--format', '{{.Id}}')
    report['squid_version'] = cmd('docker', 'run', '--rm', '--network', 'none',
                                '--entrypoint', 'squid', image, '-v')
    version = re.search(r'Version (\d+)\.(\d+)', report['squid_version'])
    check('Squid includes the 7.6 HTTP framing fix', version and tuple(map(int, version.groups())) >= (7, 6))
    cmd('docker', 'network', 'create', '--internal', name)
    config = json.loads(cmd('docker', 'network', 'inspect', name, '--format', '{{json .IPAM.Config}}'))
    subnet = ipaddress.ip_network(config[0]['Subnet'])
    allowed_ip, denied_ip, target_ip, proxy_ip = [str(subnet.network_address + n) for n in (10, 11, 12, 13)]
    endpoint = """const net=require('node:net');
      for(const port of [443,444])net.createServer(s=>{
        console.log('DESTINATION_ACCEPTED',port);s.end('CI_PROXY_DESTINATION_OK\\n');
      }).listen(port,'0.0.0.0',()=>console.log('DESTINATION_READY',port));"""
    cmd('docker', 'run', '-d', '--name', target, '--network', name, '--ip', target_ip,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--entrypoint', 'node', client_image, '-e', endpoint)
    generate('allowed.example')
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
    generate('blocked.example')
    cmd('docker', 'exec', proxy, 'squid', '-k', 'reconfigure', '-f', '/config/squid.conf')
    for attempt in range(30):
        result = request(connect('blocked.example'))
        if result['status'] == 200 and result['greeting']:
            break
        time.sleep(.5)
    check('Atomic config replacement is applied by real reload', result['status'] == 200 and result['greeting'])
    result = request(connect())
    check('Reload revokes the previous destination', result['status'] == 403 and not result['greeting'])
    check('Reload preserves the running Squid process', proxy_pid() == pid)
    generate('allowed.example')
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
