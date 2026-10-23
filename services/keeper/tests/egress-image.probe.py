"""Real proxy-image policy/reload proof, run only in disposable Linux CI.

All clients and destinations use an internal Docker network. No published ports,
credentials, providers, installation state or host Docker socket mounts.
"""
import base64
import copy
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
import pathlib
import platform
import re
import select
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
network = name
target_name = name + '-target'
proxy_name = 'lares-egress-proxy'
owner_label = 'org.lares.egress-proof'
owner_token = uuid.uuid4().hex
custody_prefix = root / 'fixture-prefix'
admission = custody_prefix / 'var/lib/lares-maintenance/admission'
config_root = root / 'egress'
compose_file = root / 'proxy-compose.json'
proxy_id = target_id = sentinel_id = None
proxy_project = None
network_id = None
network_probe_id = None
primary_error = None
cleanup_errors = []
action = 'initialize'
report = {'source': os.environ['GITHUB_SHA'], 'checks': [], 'success': False}
sys.dont_write_bytecode = True
custody_spec = importlib.util.spec_from_file_location(
    'maintenance_custody', pathlib.Path('services/box/ops/maintenance-custody.py').resolve())
custody = importlib.util.module_from_spec(custody_spec)
assert custody_spec and custody_spec.loader
custody_spec.loader.exec_module(custody)


def cmd(*args, input=None):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        raise RuntimeError(action)
    return result.stdout.strip()


def check(label, condition):
    assert condition, label
    report['checks'].append(label)
    print('PASS:', label, flush=True)


def inspect_container(identifier):
    return json.loads(cmd('docker', 'inspect', identifier))[0]


def inspect_network(identifier):
    return json.loads(cmd('docker', 'network', 'inspect', identifier))[0]


def container_name_is_free():
    matches = cmd('docker', 'ps', '-aq', '--filter', f'name={proxy_name}')
    for identifier in matches.splitlines():
        if inspect_container(identifier).get('Name') == '/' + proxy_name:
            return False
    return True


def verify_container_owner(identifier, *, service=None, role=None, project=None):
    item = inspect_container(identifier)
    labels = item.get('Config', {}).get('Labels') or {}
    if service is not None:
        return labels.get('com.docker.compose.project') == (project or name) and \
            labels.get('com.docker.compose.service') == service and item.get('Name') == '/' + proxy_name
    return labels.get(owner_label) == owner_token and labels.get(owner_label + '.role') == role


def remove_owned_container(identifier, *, service=None, role=None, project=None):
    if not identifier:
        return True
    try:
        if not verify_container_owner(identifier, service=service, role=role, project=project):
            cleanup_errors.append('container ownership could not be verified')
            return False
        item = inspect_container(identifier)
        if item.get('State', {}).get('Running'):
            cmd('docker', 'stop', '--time', '10', identifier)
        item = inspect_container(identifier)
        if item.get('State', {}).get('Running') or item.get('State', {}).get('Status') not in ('exited', 'created'):
            cleanup_errors.append('owned container did not stop cleanly')
            return False
        cmd('docker', 'rm', identifier)
        remaining = cmd('docker', 'ps', '-aq', '--no-trunc', '--filter', f'id={identifier}')
        if remaining:
            cleanup_errors.append('owned container remained after removal')
            return False
        return True
    except Exception:
        cleanup_errors.append('owned container cleanup failed')
        return False


def remove_owned_network(identifier):
    if not identifier:
        return True
    try:
        item = inspect_network(identifier)
        labels = item.get('Labels') or {}
        if labels.get(owner_label) != owner_token or labels.get(owner_label + '.role') not in (
                'network', 'ipam-probe'):
            cleanup_errors.append('network ownership could not be verified')
            return False
        cmd('docker', 'network', 'rm', identifier)
        remaining = cmd('docker', 'network', 'ls', '-q', '--no-trunc', '--filter', f'id={identifier}')
        if remaining:
            cleanup_errors.append('owned network remained after removal')
            return False
        return True
    except Exception:
        cleanup_errors.append('owned network cleanup failed')
        return False


def host_gate_is_exclusive_blocked(gate_path):
    descriptor = os.open(gate_path, os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) |
                         getattr(os, 'O_NOFOLLOW', 0))
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            return False
        except BlockingIOError:
            return True
    finally:
        os.close(descriptor)


def _safe_error(exc):
    if isinstance(exc, PermissionError):
        category = 'permission'
    elif isinstance(exc, FileNotFoundError):
        category = 'not_found'
    elif isinstance(exc, ProcessLookupError):
        category = 'process_lookup'
    elif isinstance(exc, OSError):
        category = 'os_error'
    else:
        category = 'other'
    return {'category': category, 'errno': exc.errno if isinstance(exc, OSError) else None}


def _read_bounded_process_output(process, limit=4096, timeout=30):
    output = bytearray()
    deadline = time.monotonic() + timeout
    result = {'returncode': None, 'timed_out': False, 'oversized': False,
              'read_error_category': None, 'read_error_errno': None,
              'cleanup_ok': True, 'cleanup_failures': []}
    cleanup_attempted = False

    def fail_cleanup(kind):
        result['cleanup_ok'] = False
        if kind not in result['cleanup_failures']:
            result['cleanup_failures'].append(kind)

    def kill_and_reap():
        nonlocal cleanup_attempted
        cleanup_attempted = True
        try:
            running = process.poll() is None
        except Exception:
            running = True
            fail_cleanup('poll')
        if running:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            except Exception:
                fail_cleanup('kill')
        try:
            result['returncode'] = process.wait(timeout=1)
            if result['returncode'] is None:
                raise subprocess.TimeoutExpired('diagnostic process', 1)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            except Exception:
                fail_cleanup('kill')
            try:
                result['returncode'] = process.wait(timeout=1)
                if result['returncode'] is None:
                    fail_cleanup('reap')
            except subprocess.TimeoutExpired:
                fail_cleanup('reap')
            except Exception:
                fail_cleanup('reap')
        except Exception:
            fail_cleanup('reap')

    read_failed = False
    try:
        try:
            descriptor = process.stdout.fileno()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    result['timed_out'] = True
                    break
                readable, _, _ = select.select([descriptor], [], [], remaining)
                if not readable:
                    result['timed_out'] = True
                    break
                chunk = os.read(descriptor, min(1024, limit + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > limit:
                    result['oversized'] = True
                    break
        except OSError as exc:
            read_failed = True
            safe = _safe_error(exc)
            result['read_error_category'] = safe['category']
            result['read_error_errno'] = safe['errno']
        except (ValueError, TypeError):
            read_failed = True
            result['read_error_category'] = 'invalid_descriptor'
        except Exception:
            read_failed = True
            result['read_error_category'] = 'other'

        if read_failed or result['timed_out'] or result['oversized']:
            kill_and_reap()
        else:
            try:
                result['returncode'] = process.wait(timeout=2)
                if result['returncode'] is None:
                    result['timed_out'] = True
                    kill_and_reap()
            except subprocess.TimeoutExpired:
                result['timed_out'] = True
                kill_and_reap()
            except Exception:
                fail_cleanup('reap')
                kill_and_reap()
    finally:
        if not cleanup_attempted and result['returncode'] is None:
            kill_and_reap()
        try:
            process.stdout.close()
        except Exception:
            fail_cleanup('stdout_close')

    result['output'] = bytes(output[:limit])
    return result


def _sanitize_process_gate_json(value):
    if not isinstance(value, dict) or value.get('version') != 1:
        return None
    status = value.get('pid_status')
    descriptor = value.get('fd9')
    info = value.get('fdinfo')
    if not all(isinstance(item, dict) for item in (status, descriptor, info)):
        return None

    def boolean(source, key):
        return source.get(key) if isinstance(source.get(key), bool) else False

    def number(source, key):
        result = source.get(key)
        return result if isinstance(result, int) and not isinstance(result, bool) and result >= 0 else None

    def safe_error_fields(source):
        category = source.get('error_category')
        if category not in ('permission', 'not_found', 'process_lookup', 'os_error', 'other'):
            category = None
        return {'error_category': category, 'errno': number(source, 'errno')}

    return {
        'pid_status': {
            'readable': boolean(status, 'readable'),
            'name_is_squid': boolean(status, 'name_is_squid'),
            'state_present': boolean(status, 'state_present'),
            'parent_pid': number(status, 'parent_pid'),
            'effective_uid': number(status, 'effective_uid'),
            **safe_error_fields(status),
        },
        'fd9': {
            'stat_ok': boolean(descriptor, 'stat_ok'),
            'same_inode': boolean(descriptor, 'same_inode'),
            **safe_error_fields(descriptor),
        },
        'fdinfo': {
            'readable': boolean(info, 'readable'),
            'lock_count': number(info, 'lock_count'),
            'single_flock': boolean(info, 'single_flock'),
            'advisory_read': boolean(info, 'advisory_read'),
            'write_absent': boolean(info, 'write_absent'),
            **safe_error_fields(info),
        },
    }


def process_gate_evidence(pid, gate_path):
    expected = os.stat(gate_path, follow_symlinks=False)
    script = r'''import json,os,sys
p=sys.argv[1]
expected_dev=int(sys.argv[2]); expected_ino=int(sys.argv[3])
def fail(exc):
    if isinstance(exc,PermissionError): category='permission'
    elif isinstance(exc,FileNotFoundError): category='not_found'
    elif isinstance(exc,ProcessLookupError): category='process_lookup'
    elif isinstance(exc,OSError): category='os_error'
    else: category='other'
    return {'error_category':category,'errno':exc.errno if isinstance(exc,OSError) else None}
result={'version':1,
        'pid_status':{'readable':False},
        'fd9':{'stat_ok':False},
        'fdinfo':{'readable':False}}
try:
    fields={}
    with open('/proc/'+p+'/status','rb') as status:
        for raw in status.read(4096).splitlines():
            key,sep,value=raw.partition(b':')
            if sep and key in (b'Name',b'State',b'PPid',b'Uid'):
                fields[key]=value.strip().split()
    uid=fields.get(b'Uid',[])
    parent=fields.get(b'PPid',[])
    result['pid_status']={'readable':True,
                          'name_is_squid':fields.get(b'Name',[b''])[0]==b'squid',
                          'state_present':bool(fields.get(b'State')),
                          'parent_pid':int(parent[0]) if parent else None,
                          'effective_uid':int(uid[1]) if len(uid)>1 else None}
except Exception as exc:
    result['pid_status'].update(fail(exc))
try:
    stat=os.stat('/proc/'+p+'/fd/9')
    result['fd9']={'stat_ok':True,
                   'same_inode':stat.st_dev==expected_dev and stat.st_ino==expected_ino}
except Exception as exc:
    result['fd9'].update(fail(exc))
try:
    with open('/proc/'+p+'/fdinfo/9','rb') as info:
        lines=info.read(4096).decode('ascii','replace').splitlines()
    locks=[line for line in lines if line.startswith('lock:')]
    lock=locks[0] if len(locks)==1 else ''
    result['fdinfo']={'readable':True,'lock_count':len(locks),
                      'single_flock':len(locks)==1 and 'FLOCK' in lock,
                      'advisory_read':len(locks)==1 and 'ADVISORY READ' in lock,
                      'write_absent':len(locks)==1 and 'WRITE' not in lock}
except Exception as exc:
    result['fdinfo'].update(fail(exc))
print(json.dumps(result,separators=(',',':')))
'''
    process = None
    try:
        process = subprocess.Popen(
            ['docker', 'exec', proxy_id, '/usr/bin/python3', '-I', '-c', script, pid,
             str(expected.st_dev), str(expected.st_ino)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        capture = _read_bounded_process_output(process)
        output = capture['output']
        returncode = capture['returncode']
        result = {'docker_exec_returncode': returncode,
                  'docker_exec_timed_out': capture['timed_out'],
                  'docker_exec_output_oversized': capture['oversized'],
                  'diagnostic_read_error_category': capture['read_error_category'],
                  'diagnostic_read_error_errno': capture['read_error_errno'],
                  'diagnostic_process_cleanup_ok': capture['cleanup_ok'],
                  'diagnostic_process_cleanup_failures': capture['cleanup_failures'],
                  'diagnostic_valid': False}
        if capture['cleanup_ok'] and returncode == 0 and not capture['timed_out'] and \
                not capture['oversized'] and not capture['read_error_category']:
            try:
                parsed = json.loads(output.decode('ascii'))
                safe = _sanitize_process_gate_json(parsed)
                if safe is not None:
                    result.update(safe)
                    result['diagnostic_valid'] = True
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
        return result
    except OSError as exc:
        return {'docker_exec_returncode': None, 'docker_exec_timed_out': False,
                'docker_exec_output_oversized': False, 'diagnostic_valid': False,
                'docker_exec_error_category': _safe_error(exc)['category'],
                'docker_exec_errno': _safe_error(exc)['errno']}


def host_gate_exclusive_evidence(gate_path):
    descriptor = None
    try:
        descriptor = os.open(gate_path, os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) |
                             getattr(os, 'O_NOFOLLOW', 0))
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            return {'blocked': False, 'acquired': True, 'error_category': None, 'errno': None}
        except BlockingIOError:
            return {'blocked': True, 'acquired': False, 'error_category': None, 'errno': None}
    except OSError as exc:
        safe = _safe_error(exc)
        return {'blocked': False, 'acquired': False,
                'error_category': safe['category'], 'errno': safe['errno']}
    finally:
        if descriptor is not None:
            os.close(descriptor)


def assert_proxy_lease(gate_path, pid, label):
    evidence = process_gate_evidence(pid, gate_path)
    host_evidence = host_gate_exclusive_evidence(gate_path)
    report.setdefault('lease_diagnostics', []).append({
        'phase': label,
        'pid': int(pid) if str(pid).isdigit() else None,
        'process': evidence,
        'host_exclusive': host_evidence,
    })
    process_ok = evidence.get('diagnostic_valid') is True and \
        evidence['pid_status']['readable'] and evidence['pid_status']['name_is_squid'] and \
        evidence['fd9']['stat_ok'] and evidence['fd9']['same_inode'] and \
        evidence['fdinfo']['readable'] and evidence['fdinfo']['lock_count'] == 1 and \
        evidence['fdinfo']['single_flock'] and evidence['fdinfo']['advisory_read'] and \
        evidence['fdinfo']['write_absent']
    check(label + ': serving Squid owns fd9 for the exact host gate inode with a shared lock',
          process_ok)
    check(label + ': host cannot acquire the exclusive gate while Squid serves',
          host_evidence['blocked'])


def wait_for_proxy():
    global result
    for _attempt in range(30):
        result = request(connect())
        if result['status'] == 200 and result['greeting']:
            return
        item = inspect_container(proxy_id)
        if not item.get('State', {}).get('Running'):
            raise RuntimeError(action)
        time.sleep(.5)
    raise RuntimeError(action)


def compose(*args):
    return cmd('docker', 'compose', '--project-name', name, '--file', str(compose_file), *args)


def rendered_compose_environment(subnet, proxy_address, identity, epoch):
    source = pathlib.Path('services/box/compose.lares-keeper.yaml').resolve()
    text = source.read_text()
    variables = set(re.findall(r'\$\{([A-Z_]+)(?::[-?])', text))
    env = os.environ.copy()
    for variable in variables:
        if variable.endswith('_IMAGE'):
            env[variable] = client_image if variable == 'LARES_KEEPER_IMAGE' else image
        elif variable == 'LARES_NETWORK':
            env[variable] = network
        elif variable == 'LARES_PROXY_ADDRESS':
            env[variable] = proxy_address
        elif variable == 'LARES_EGRESS_DIR':
            env[variable] = str(config_root)
        elif variable == 'LARES_MAINTENANCE_ADMISSION_DIR':
            env[variable] = str(admission)
        elif variable == 'LARES_MAINTENANCE_INSTALLATION_ID':
            env[variable] = identity
        elif variable == 'LARES_MAINTENANCE_EPOCH':
            env[variable] = str(epoch)
        elif variable == 'LARES_SUBNET':
            env[variable] = str(subnet)
        elif variable.endswith(('_DIR', '_ROOT', '_FILE', '_CONFIG', '_TARGET')):
            env[variable] = str(root / 'compose-placeholder')
        else:
            env[variable] = 'fixture.invalid'
    result = subprocess.run(['docker', 'compose', '--project-name', name, '-f', str(source),
                             'config', '--format', 'json'], env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        raise RuntimeError(action)
    return json.loads(result.stdout)


def assert_generated_service(service, identity, epoch, proxy_address):
    check('Generated proxy keeps its fixed container name', service.get('container_name') == proxy_name)
    check('Generated proxy uses the fixed isolated guard and unchanged Squid argv',
          service.get('entrypoint') == ['/usr/bin/python3', '-I',
                                       '/usr/local/lib/lares/maintenance-admission.py'] and
          service.get('command') == ['squid', '-N', '-f', '/config/squid.conf'])
    check('Generated proxy receives the validated receipt coordinates explicitly',
          service.get('environment') == {
              'LARES_MAINTENANCE_EPOCH': str(epoch),
              'LARES_MAINTENANCE_INSTALLATION_ID': identity,
          })
    check('Generated proxy preserves init, restart and its reserved address',
          service.get('init') is True and service.get('restart') == 'unless-stopped' and
          service.get('networks') == {'lares-network': {'ipv4_address': proxy_address}})
    volumes = service.get('volumes', [])
    admission_mounts = [mount for mount in volumes if isinstance(mount, dict) and
                        mount.get('target') == '/run/lares-maintenance/admission']
    config_mounts = [mount for mount in volumes if isinstance(mount, dict) and mount.get('target') == '/config']
    check('Generated proxy has one exact readonly no-create admission child and its config directory',
          len(volumes) == 2 and all(isinstance(mount, dict) for mount in volumes) and
          len(admission_mounts) == 1 and len(config_mounts) == 1 and
          admission_mounts[0].get('type') == 'bind' and config_mounts[0].get('type') == 'bind' and
          admission_mounts[0].get('source') == str(admission) and
          admission_mounts[0].get('read_only') is True and
          isinstance(admission_mounts[0].get('bind'), dict) and
          admission_mounts[0]['bind'].get('create_host_path', False) is False and
          config_mounts[0].get('source') == str(config_root) and
          config_mounts[0].get('read_only') is True and
          not any('custody' in mount.get('source', '') or 'preparation.json' in mount.get('source', '')
                  for mount in volumes))
    check('Generated proxy exposes no listener ports', not service.get('ports') and not service.get('expose'))


def verify_created_proxy(identifier, identity, epoch, proxy_address):
    item = inspect_container(identifier)
    config = item.get('Config', {})
    host = item.get('HostConfig', {})
    mounts = item.get('Mounts', [])
    labels = config.get('Labels') or {}
    networks = item.get('NetworkSettings', {}).get('Networks') or {}
    env = dict(value.split('=', 1) for value in config.get('Env', []) if '=' in value)
    check('Created proxy is owned by this unique Compose project and fixed service',
          labels.get('com.docker.compose.project') == name and
          labels.get('com.docker.compose.service') == 'lares-egress-proxy' and
          item.get('Name') == '/' + proxy_name)
    check('Created proxy keeps actual guarded command, init and restart policy',
          config.get('Entrypoint') == ['/usr/bin/python3', '-I',
                                      '/usr/local/lib/lares/maintenance-admission.py'] and
          config.get('Cmd') == ['squid', '-N', '-f', '/config/squid.conf'] and
          host.get('Init') is True and host.get('RestartPolicy', {}).get('Name') == 'unless-stopped')
    check('Created proxy carries validated receipt values and no other admission authority',
          env.get('LARES_MAINTENANCE_INSTALLATION_ID') == identity and
          env.get('LARES_MAINTENANCE_EPOCH') == str(epoch) and
          not any(key.startswith('LARES_MAINTENANCE_') and key not in {
              'LARES_MAINTENANCE_INSTALLATION_ID', 'LARES_MAINTENANCE_EPOCH'} for key in env))
    actual_mounts = {(mount.get('Type'), mount.get('Source'), mount.get('Destination')) for mount in mounts}
    check('Created proxy has only the config and exact readonly admission mounts',
          actual_mounts == {
              ('bind', str(config_root.resolve()), '/config'),
              ('bind', str(admission.resolve()), '/run/lares-maintenance/admission'),
          } and all(not mount.get('RW', True) for mount in mounts) and
          not any('/custody' in mount.get('Destination', '') or 'preparation.json' in mount.get('Destination', '')
                  for mount in mounts))
    proxy_network = networks.get(network, {})
    check('Created proxy uses the owned internal network and reserved fixture IP',
          list(networks) == [network] and proxy_network.get('IPAddress') == proxy_address)


def service_compose_config(env):
    result = subprocess.run(['docker', 'compose', '--project-name', name, '--file', str(compose_file),
                             'config', '--format', 'json'], env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        raise RuntimeError(action)
    return json.loads(result.stdout)


def check_container_name_available():
    if not container_name_is_free():
        raise RuntimeError('fixed proxy container name is already in use')


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
        '--mount', f'type=bind,src={config_root},dst=/output', '--entrypoint',
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
    return cmd('docker', 'logs', target_id).count('DESTINATION_ACCEPTED')


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
    return cmd('docker', 'exec', proxy_id, 'sh', '-c',
               'for p in /run/squid.pid /run/squid/squid.pid; do '
               'if [ -f "$p" ]; then cat "$p"; exit; fi; done; exit 1')


def run_proof():
    global action, network_id, network_probe_id, proxy_ip, allowed_ip, denied_ip, target_ip, proxy_project
    global proxy_id, target_id, sentinel_id

    action = 'refuse a pre-existing fixed proxy container name'
    check('Fixed proxy name is unoccupied before fixture resources are created', container_name_is_free())
    report['image_id'] = cmd('docker', 'image', 'inspect', image, '--format', '{{.Id}}')
    report['client_image_id'] = cmd('docker', 'image', 'inspect', client_image, '--format', '{{.Id}}')
    report['candidate_image_reference'] = image
    image_config = json.loads(cmd('docker', 'image', 'inspect', image))[0]['Config']
    check('Built image defaults to the isolated baked guard and retains the fixed Squid CMD',
          image_config.get('Entrypoint') == ['/usr/bin/python3', '-I',
                                             '/usr/local/lib/lares/maintenance-admission.py'] and
          image_config.get('Cmd') == ['squid', '-N', '-f', '/config/squid.conf'])

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
    runtime = json.loads(cmd('docker', 'run', '--rm', '--network', 'none', '--entrypoint',
                             '/usr/bin/python3', image, '-I', '-c',
                             "import fcntl,os,stat; g=os.stat('/usr/local/lib/lares/maintenance-admission.py'); print(__import__('json').dumps({'uid':os.geteuid(),'flock':hasattr(fcntl,'flock'),'squid':os.access('/usr/sbin/squid',os.X_OK),'guard':stat.S_ISREG(g.st_mode) and g.st_uid == 0 and stat.S_IMODE(g.st_mode) == 0o555}))"))
    check('Pinned image provides isolated Python, flock, root, fixed Squid executable and root-owned guard',
          runtime == {'uid': 0, 'flock': True, 'squid': True, 'guard': True})
    check_raw_response_parser(client_image)

    action = 'run the complete refusal matrix against the baked startup guard'
    guard_tests = pathlib.Path('services/keeper/tests/egress-admission.test.py').resolve()
    matrix = subprocess.run(
        ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
         '--cap-add', 'CHOWN', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777',
         '--security-opt', 'no-new-privileges:true',
         '--mount', f'type=bind,src={guard_tests},dst=/egress-admission.test.py,readonly',
         '--entrypoint', '/usr/bin/python3', image, '-I', '/egress-admission.test.py'],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    matrix_output = matrix.stdout + matrix.stderr
    count = re.search(r'Ran (\d+) tests?', matrix_output)
    matrix_ok = (matrix.returncode == 0 and count is not None and count.group(1) == '7' and
                 re.search(r'^OK$', matrix_output, re.M) is not None and
                 re.search(r'\bskipped=', matrix_output) is None)
    check('Baked guard passes seven root-owned cases with refusal exit 78 and no exec before Squid',
          matrix_ok)
    report['guard_refusal_matrix'] = {
        'tests': int(count.group(1)) if count else 0,
        'cases': [
            'blocked/entering intent', 'identity and epoch mismatch', 'missing/oversized/noncanonical intent',
            'unsafe owner/mode/link/ancestry', 'FIFO and replaced descriptors', 'exclusive gate lease',
            'low-descriptor fd9 promotion retains the shared gate at fixed exec',
        ],
        'exit': matrix.returncode,
        'skipped': False,
        'network': 'none',
        'config_mount': False,
    }

    action = 'create isolated internal fixture network'
    probe_name = name + '-ipam-probe'
    network_probe_id = cmd('docker', 'network', 'create', '--internal', '--label',
                           f'{owner_label}={owner_token}', '--label',
                           f'{owner_label}.role=ipam-probe', probe_name)
    probe_info = inspect_network(network_probe_id)
    check('Temporary Docker-assigned subnet comes from a uniquely owned internal network',
          probe_info.get('Internal') is True and
          (probe_info.get('Labels') or {}).get(owner_label) == owner_token)
    ipam_config = probe_info.get('IPAM', {}).get('Config') or []
    if not ipam_config or not ipam_config[0].get('Subnet'):
        raise RuntimeError(action)
    subnet = ipaddress.ip_network(ipam_config[0]['Subnet'])
    if subnet.version != 4:
        raise RuntimeError(action)
    check('Docker-assigned subnet has room for the fixed isolated proof addresses', subnet.num_addresses > 32)
    if not remove_owned_network(network_probe_id):
        raise RuntimeError(action)
    network_probe_id = None
    network_id = cmd('docker', 'network', 'create', '--internal', '--subnet', str(subnet),
                     '--label', f'{owner_label}={owner_token}', '--label',
                     f'{owner_label}.role=network', name)
    network_info = inspect_network(network_id)
    check('Fixture network is internal and uniquely owned',
          network_info.get('Internal') is True and
          (network_info.get('Labels') or {}).get(owner_label) == owner_token and
          ipaddress.ip_network(network_info['IPAM']['Config'][0]['Subnet']) == subnet)
    allowed_ip, denied_ip, target_ip, proxy_ip = [str(subnet.network_address + n) for n in (10, 11, 12, 13)]

    action = 'prepare root-owned completed receipt and normal admission fixture'
    custody_prefix.mkdir(mode=0o755)
    config_root.mkdir(mode=0o755)
    custody.prepare_fresh(custody_prefix, str(subnet))
    receipt = custody.validate(custody_prefix, str(subnet))
    identity, epoch = receipt['installationId'], receipt['epoch']
    gate_path = admission / 'service-gate.lock'
    check('Host fixture has a completed validated preparation receipt and normal intent',
          identity and epoch == 1 and custody.read_intent(admission) == {
              'version': 1, 'installationId': identity, 'epoch': epoch, 'state': 'normal'})

    initial_stage, desired_stage, restored_stage = (str(uuid.uuid4()) for _ in range(3))
    report['fixture_route_stages'] = {
        'initial': initial_stage, 'desired_before_reload': desired_stage, 'restored': restored_stage,
    }
    endpoint = """const net=require('node:net');
      for(const port of [443,444])net.createServer(s=>{
        console.log('DESTINATION_ACCEPTED',port);s.end('CI_PROXY_DESTINATION_OK\\n');
      }).listen(port,'0.0.0.0',()=>console.log('DESTINATION_READY',port));"""
    action = 'start separately owned isolated destination fixture'
    target_id = cmd('docker', 'run', '-d', '--name', target_name, '--network', name,
                    '--ip', target_ip, '--network-alias', 'allowed.example',
                    '--network-alias', 'blocked.example', '--label',
                    f'{owner_label}={owner_token}', '--label', f'{owner_label}.role=target',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '--entrypoint', 'node', client_image, '-e', endpoint)
    check('Destination fixture is separately owned and DNS aliases stay outside the production service',
          verify_container_owner(target_id, role='target'))

    action = 'generate normal Squid configuration with the real egress generator'
    generate('allowed.example', initial_stage)
    conf = (config_root / 'squid.conf').read_text()
    check('Generated config disables caching and enables no ICP or collapsed forwarding',
          'cache deny all' in conf and not re.search(r'^(icp_port|collapsed_forwarding|include)\b', conf, re.M))
    cmd('docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges:true',
        '--mount', f'type=bind,src={config_root},dst=/config,readonly',
        '--entrypoint', 'squid', image, '-k', 'parse', '-f', '/config/squid.conf')

    action = 'resolve and compare the full generated production proxy service'
    generated = rendered_compose_environment(subnet, proxy_ip, identity, epoch)
    service = generated['services']['lares-egress-proxy']
    assert_generated_service(service, identity, epoch, proxy_ip)
    check('Generated production service selects only the candidate Squid image', service.get('image') == image)
    generated_network = generated['networks']['lares-network']
    check('Generated service binds to the unique internal external-network fixture',
          generated_network.get('external') is True and generated_network.get('name') == network)
    report['generated_service_sha256'] = hashlib.sha256(
        json.dumps(service, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    isolated = {'services': {'lares-egress-proxy': service},
                'networks': {'lares-network': generated_network}}
    compose_file.write_text(json.dumps(isolated, sort_keys=True) + '\n')
    canonical = service_compose_config(os.environ.copy())
    canonical_service = canonical['services']['lares-egress-proxy']
    check('Isolated Compose proof preserves the full generated service without contract edits',
          canonical_service == service and canonical['networks']['lares-network'] == generated_network)

    action = 'prove the read-only no-create bind refuses a missing host admission directory'
    missing = copy.deepcopy(isolated)
    missing_source = root / 'missing-admission'
    missing_mount = next(item for item in missing['services']['lares-egress-proxy']['volumes']
                         if item.get('target') == '/run/lares-maintenance/admission')
    missing_mount['source'] = str(missing_source)
    negative_compose = root / 'missing-bind-compose.json'
    negative_compose.write_text(json.dumps(missing, sort_keys=True) + '\n')
    missing_project = name + '-missing'
    missing_result = subprocess.run(['docker', 'compose', '--project-name', missing_project,
                                     '--file', str(negative_compose), 'create', 'lares-egress-proxy'],
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    missing_error = (missing_result.stdout + missing_result.stderr).lower()
    missing_error_is_specific = str(missing_source).lower() in missing_error and any(
        phrase in missing_error for phrase in ('does not exist', 'no such file', 'not found'))
    if not container_name_is_free():
        unexpected = inspect_container(proxy_name)
        labels = unexpected.get('Config', {}).get('Labels') or {}
        if labels.get('com.docker.compose.project') == missing_project:
            proxy_id = unexpected['Id']
            proxy_project = missing_project
    check('Compose creation fails for missing no-create admission source without creating it',
          missing_result.returncode != 0 and missing_error_is_specific and
          not missing_source.exists() and container_name_is_free())

    action = 'prove fixed-name collision is refused without adopting or changing the existing container'
    sentinel_id = cmd('docker', 'create', '--name', proxy_name, '--network', name, '--label',
                      f'{owner_label}={owner_token}', '--label', f'{owner_label}.role=sentinel',
                      '--entrypoint', 'node', client_image, '-e', 'process.exit(0)')
    before_sentinel = inspect_container(sentinel_id)
    refused = False
    try:
        check_container_name_available()
    except RuntimeError as error:
        refused = str(error) == 'fixed proxy container name is already in use'
    after_sentinel = inspect_container(sentinel_id)
    check('Fixed-name collision is refused and the pre-existing owned sentinel is unchanged',
          refused and before_sentinel['Id'] == after_sentinel['Id'] and
          before_sentinel['State']['Status'] == after_sentinel['State']['Status'] == 'created' and
          (after_sentinel.get('Config', {}).get('Labels') or {}).get(owner_label) == owner_token)
    if remove_owned_container(sentinel_id, role='sentinel') and container_name_is_free():
        sentinel_id = None
    else:
        cleanup_errors.append('collision sentinel remained after checked cleanup')

    action = 'create and inspect the actual generated production service'
    check_container_name_available()
    compose('create', 'lares-egress-proxy')
    proxy_id = compose('ps', '-aq', 'lares-egress-proxy')
    proxy_project = name
    if not proxy_id:
        raise RuntimeError(action)
    verify_created_proxy(proxy_id, identity, epoch, proxy_ip)

    action = 'start guarded Squid through the generated production service'
    compose('start', 'lares-egress-proxy')
    wait_for_proxy()
    pid = proxy_pid()
    check('Squid PID is behind Docker init and reloadable', pid.isdigit() and int(pid) > 1)
    assert_proxy_lease(gate_path, pid, 'Initial serve')
    process_runtime = json.loads(cmd('docker', 'exec', proxy_id, '/usr/bin/python3', '-I', '-c',
                                     "import fcntl,json,os; print(json.dumps({'uid':os.geteuid(),'flock':hasattr(fcntl,'flock'),'python':os.path.realpath('/proc/self/exe') == os.path.realpath('/usr/bin/python3')}))"))
    check('Running guard image executes isolated stdlib Python as root',
          process_runtime == {'uid': 0, 'flock': True, 'python': True})
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

    action = 'prove generation and reload behavior on the real service'
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
    cmd('docker', 'exec', proxy_id, 'squid', '-k', 'reconfigure', '-f', '/config/squid.conf')
    for attempt in range(30):
        result = request(connect('blocked.example'))
        if result['status'] == 200 and result['greeting']:
            break
        time.sleep(.5)
    check('Atomic config replacement is applied by real reload', result['status'] == 200 and result['greeting'])
    assert_proxy_lease(gate_path, proxy_pid(), 'After reload')
    before_reloaded_probe_target_count = target_connections()
    reloaded_route_response = request(connect(route_host))
    after_reloaded_probe_target_count = target_connections()
    check('Denied CONNECT reports the exact reloaded Squid generation',
          route_stage_acknowledged(reloaded_route_response, desired_stage))
    check('Reloaded denied generation probe adds zero target connections',
          after_reloaded_probe_target_count == before_reloaded_probe_target_count)
    report['route_generation_proof'] = {
        'before_reload': stale_route_response,
        'expected_before_reload': initial_stage,
        'desired_before_reload': desired_stage,
        'after_reload': reloaded_route_response,
        'expected_after_reload': desired_stage,
        'target_connection_delta_before_reload': after_stale_probe_target_count - before_stale_probe_target_count,
        'target_connection_delta_after_reload': after_reloaded_probe_target_count - before_reloaded_probe_target_count,
        'marker_is_fixture_augmentation': True,
    }
    result = request(connect())
    check('Reload revokes the previous destination', result['status'] == 403 and not result['greeting'])
    check('Reload preserves the running Squid process', proxy_pid() == pid)
    generate('allowed.example', restored_stage)
    cmd('docker', 'exec', proxy_id, 'squid', '-k', 'reconfigure', '-f', '/config/squid.conf')
    for attempt in range(30):
        result = request(connect())
        if result['status'] == 200 and result['greeting']:
            break
        time.sleep(.5)
    check('Reload can restore the original grant', result['status'] == 200 and result['greeting'])
    assert_proxy_lease(gate_path, proxy_pid(), 'After restore reload')
    sockets = cmd('docker', 'exec', proxy_id, 'sh', '-c', 'cat /proc/net/udp /proc/net/udp6')
    check('ICP and HTCP have no UDP listener', not re.search(r':(?:0C3A|12DB)\s', sockets))

    action = 'prove the same Squid gate descriptor survives Docker restart'
    container_before_restart = proxy_id
    compose('restart', 'lares-egress-proxy')
    wait_for_proxy()
    check('Docker restart preserves the exact owned Compose container',
          compose('ps', '-aq', 'lares-egress-proxy') == container_before_restart)
    restarted_pid = proxy_pid()
    check('Restarted Squid remains behind init as a reloadable child',
          restarted_pid.isdigit() and int(restarted_pid) > 1)
    assert_proxy_lease(gate_path, restarted_pid, 'After Docker restart')

    action = 'prove non-normal intent refuses a restarted Squid before listener or destination effects'
    connections_before_refusal = target_connections()
    custody.transition(custody_prefix / 'var/lib/lares-maintenance/custody', admission,
                       identity, epoch, 'entering')
    check('Serving Squid still holds its shared lease after intent enters maintenance',
          host_gate_is_exclusive_blocked(gate_path))
    compose('restart', 'lares-egress-proxy')
    refusal = request(connect())
    check('Non-normal restart never serves or reaches the controlled destination',
          refusal['status'] is None and not refusal['greeting'] and
          target_connections() == connections_before_refusal)
    cmd('docker', 'stop', '--time', '10', proxy_id)
    item = inspect_container(proxy_id)
    check('Guarded proxy is confirmed stopped before its host lease is tested',
          not item.get('State', {}).get('Running') and item.get('State', {}).get('Status') == 'exited')
    check('Host exclusive lease becomes available only after bounded Squid stop',
          not host_gate_is_exclusive_blocked(gate_path))
    if remove_owned_container(proxy_id, service='lares-egress-proxy', project=name):
        proxy_id = None
    check('Stopped production-service container is removed by exact owned ID', container_name_is_free())


try:
    run_proof()
except Exception:
    primary_error = action
finally:
    if proxy_id:
        if remove_owned_container(proxy_id, service='lares-egress-proxy', project=proxy_project):
            proxy_id = None
    if sentinel_id:
        if remove_owned_container(sentinel_id, role='sentinel'):
            sentinel_id = None
    if target_id:
        if remove_owned_container(target_id, role='target'):
            target_id = None
    if network_id:
        if remove_owned_network(network_id):
            network_id = None
    if network_probe_id:
        if remove_owned_network(network_probe_id):
            network_probe_id = None
    if (not proxy_id and not sentinel_id and not target_id and not network_id and
            not network_probe_id and not cleanup_errors):
        try:
            shutil.rmtree(root)
            if root.exists():
                cleanup_errors.append('fixture root remained after cleanup')
        except Exception:
            cleanup_errors.append('fixture root cleanup failed')
    report['cleanup'] = {
        'proxy_container_removed': proxy_id is None,
        'sentinel_container_removed': sentinel_id is None,
        'target_container_removed': target_id is None,
        'network_removed': network_id is None,
        'temporary_ipam_network_removed': network_probe_id is None,
        'fixture_root_removed': not root.exists(),
        'errors': cleanup_errors,
    }
    report['success'] = primary_error is None and not cleanup_errors and all(
        report['cleanup'][key] for key in ('proxy_container_removed', 'sentinel_container_removed',
                                           'target_container_removed', 'network_removed',
                                           'temporary_ipam_network_removed',
                                           'fixture_root_removed'))
    if primary_error:
        report['error'] = primary_error
    pathlib.Path(output).write_text(json.dumps(report, indent=2) + '\n')

if not report['success']:
    raise SystemExit('egress runtime proof failed; see fixed-output evidence artifact')
