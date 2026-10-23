"""Real proxy-image policy/reload proof, run only in disposable Linux CI.

All clients and destinations use an internal Docker network. No published ports,
credentials, providers, installation state or host Docker socket mounts.
"""
import base64
import ast
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
from unittest.mock import patch

_self_test = sys.argv[1:] == ['--self-test']
if not _self_test:
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Run proxy image proof only in CI'
    assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
    image, client_image, output = sys.argv[1:]
    root = pathlib.Path(tempfile.mkdtemp(prefix='lares-proxy-proof-'))
    root.chmod(0o755)
    _source_revision = os.environ['GITHUB_SHA']
else:
    image = client_image = output = ''
    root = None
    _source_revision = 'offline-self-test'
name = 'lares-proxy-proof-' + uuid.uuid4().hex[:10]
network = name
target_name = name + '-target'
proxy_name = 'lares-egress-proxy'
owner_label = 'org.lares.egress-proof'
owner_token = uuid.uuid4().hex
custody_prefix = (root / 'fixture-prefix') if root else pathlib.Path('/unused')
admission = custody_prefix / 'var/lib/lares-maintenance/admission'
config_root = (root / 'egress') if root else pathlib.Path('/unused')
compose_file = (root / 'proxy-compose.json') if root else pathlib.Path('/unused')
proxy_id = target_id = sentinel_id = None
proxy_full_id = None
proxy_project = None
_serving_process_identity = None
network_id = None
network_probe_id = None
primary_error = None
cleanup_errors = []
action = 'initialize'
report = {'source': _source_revision, 'checks': [], 'success': False}
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
                fields[key]=([value[1:] if value.startswith(b'\t') else b''] if key==b'Name' else
                             value.strip().split())
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
            ['docker', 'exec', proxy_full_id or proxy_id, '/usr/bin/python3', '-I', '-c', script, pid,
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


class ObserverRefusal(Exception):
    def __init__(self, category, errno=None):
        super().__init__(category)
        self.category = category
        self.errno = errno if isinstance(errno, int) and errno >= 0 else None


def _bounded_bytes(path, limit):
    try:
        with open(path, 'rb', buffering=0) as stream:
            data = stream.read(limit + 1)
    except OSError as exc:
        raise ObserverRefusal(_safe_error(exc)['category'], _safe_error(exc)['errno']) from None
    if len(data) > limit:
        raise ObserverRefusal('oversized')
    return data


def parse_proc_status(data):
    fields = {}
    process_name = None
    for line in data.splitlines():
        key, separator, value = line.partition(b':')
        if separator and key in (b'Name', b'State', b'PPid', b'Uid', b'NSpid'):
            if key == b'Name':
                if process_name is not None:
                    raise ObserverRefusal('malformed_status')
                if not value.startswith(b'\t'):
                    raise ObserverRefusal('malformed_status')
                process_name = value[1:]
            else:
                fields[key] = value.strip().split()
    try:
        state = fields[b'State'][0].decode('ascii')
        parent = int(fields[b'PPid'][0])
        uids = [int(value) for value in fields[b'Uid']]
        nspids = [int(value) for value in fields[b'NSpid']]
    except (KeyError, IndexError, ValueError, UnicodeDecodeError):
        raise ObserverRefusal('malformed_status') from None
    if process_name is None or any(pid <= 0 for pid in nspids) or parent < 0 or len(uids) < 2:
        raise ObserverRefusal('malformed_status')
    return {'name_is_squid': process_name == b'squid', 'state': state,
            'parent_pid': parent, 'effective_uid': uids[1], 'nspids': nspids}


def parse_proc_stat(data):
    # comm is parenthesized and may itself contain spaces or closing parentheses.
    closing = data.rfind(b')')
    opening = data.find(b'(')
    if opening <= 0 or closing <= opening or closing + 2 >= len(data):
        raise ObserverRefusal('malformed_stat')
    try:
        pid = int(data[:opening].strip())
        tail = data[closing + 1:].split()
        state = tail[0].decode('ascii')
        parent = int(tail[1])
        starttime = int(tail[19])
    except (ValueError, IndexError, UnicodeDecodeError):
        raise ObserverRefusal('malformed_stat') from None
    if pid <= 0 or parent < 0 or starttime <= 0 or len(state) != 1:
        raise ObserverRefusal('malformed_stat')
    return {'pid': pid, 'state': state, 'parent_pid': parent, 'starttime': starttime}


def parse_gate_fdinfo(data):
    try:
        text = data.decode('ascii')
    except UnicodeDecodeError:
        raise ObserverRefusal('malformed_fdinfo') from None
    lines = text.splitlines()
    inode_lines = [line for line in lines if line.startswith('ino:')]
    if len(inode_lines) != 1:
        raise ObserverRefusal('fdinfo_ino_count')
    inode_match = re.fullmatch(r'ino:\s*([0-9]+)\s*', inode_lines[0])
    if not inode_match:
        raise ObserverRefusal('fdinfo_ino_shape')
    lock_lines = [line for line in lines if line.startswith('lock:')]
    if len(lock_lines) != 1:
        raise ObserverRefusal('lock_count')
    match = re.fullmatch(
        r'lock:[ \t]+\d+:[ \t]+FLOCK[ \t]+ADVISORY[ \t]+READ[ \t]+-?\d+[ \t]+'
        r'([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)[ \t]+0[ \t]+EOF',
        lock_lines[0])
    if not match:
        raise ObserverRefusal('lock_shape')
    return {'fdinfo_inode': int(inode_match.group(1)),
            'dev_major': int(match.group(1), 16), 'dev_minor': int(match.group(2), 16),
            'inode': int(match.group(3)), 'single_flock': True,
            'advisory_read': True, 'write_absent': True, 'lock_count': 1}


def _observer_command(*args, timeout=5, limit=16384):
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   bufsize=0)
    except subprocess.TimeoutExpired:
        raise ObserverRefusal('timeout') from None
    except OSError as exc:
        safe = _safe_error(exc)
        raise ObserverRefusal(safe['category'], safe['errno']) from None
    capture = _read_bounded_process_output(process, limit=limit, timeout=timeout)
    if capture['timed_out']:
        raise ObserverRefusal('timeout')
    if capture['oversized']:
        raise ObserverRefusal('oversized')
    if not capture['cleanup_ok']:
        raise ObserverRefusal('command_cleanup')
    if capture['returncode'] != 0:
        raise ObserverRefusal('command_failed')
    try:
        return capture['output'].decode('utf-8', 'strict').strip()
    except UnicodeDecodeError:
        raise ObserverRefusal('command_encoding') from None


def _verify_local_docker_host():
    if os.geteuid() != 0 or os.environ.get('GITHUB_ACTIONS') != 'true' or \
            platform.system() != 'Linux' or os.environ.get('DOCKER_HOST') or os.environ.get('DOCKER_CONTEXT'):
        raise ObserverRefusal('host_boundary')
    expected_revision = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch(r'[0-9a-f]{40}', expected_revision):
        raise ObserverRefusal('source_revision')
    checkout_revision = _observer_command(
        'git', '-C', str(pathlib.Path(__file__).resolve().parents[3]), 'rev-parse', 'HEAD',
        timeout=5, limit=128)
    if checkout_revision != expected_revision:
        raise ObserverRefusal('source_revision')
    context = _observer_command('docker', 'context', 'inspect', '--format',
                                '{{json .Endpoints.docker.Host}}', timeout=5, limit=4096)
    try:
        endpoint = json.loads(context)
    except json.JSONDecodeError:
        raise ObserverRefusal('context_metadata') from None
    if endpoint != 'unix:///var/run/docker.sock':
        raise ObserverRefusal('remote_daemon')
    try:
        if not __import__('stat').S_ISSOCK(os.stat('/var/run/docker.sock').st_mode):
            raise ObserverRefusal('daemon_socket')
    except OSError as exc:
        safe = _safe_error(exc)
        raise ObserverRefusal(safe['category'], safe['errno']) from None
    security = _observer_command('docker', 'info', '--format', '{{json .SecurityOptions}}',
                                 timeout=5, limit=4096)
    try:
        options = json.loads(security)
    except json.JSONDecodeError:
        raise ObserverRefusal('daemon_metadata') from None
    if not isinstance(options, list) or any('rootless' in str(item).lower() for item in options):
        raise ObserverRefusal('rootless_daemon')
    return True


def _current_proxy_facts():
    global proxy_full_id
    if not proxy_id or not proxy_project:
        raise ObserverRefusal('container_not_pinned')
    try:
        rendered = _observer_command(
            'docker', 'inspect', '--format',
            '{{json .Id}}|{{json .Name}}|{{json (index .Config.Labels "com.docker.compose.project")}}|'
            '{{json (index .Config.Labels "com.docker.compose.service")}}|{{json .State.Running}}|'
            '{{json .State.Pid}}|{{json .HostConfig.Init}}', proxy_full_id or proxy_id,
            timeout=5, limit=8192)
        values = [json.loads(value) for value in rendered.split('|')]
    except ObserverRefusal:
        raise
    except Exception:
        raise ObserverRefusal('container_inspect') from None
    if len(values) != 7:
        raise ObserverRefusal('container_inspect')
    full_id, container_name, project, service, running, init_pid, init = values
    if not isinstance(full_id, str) or not re.fullmatch(r'[0-9a-f]{64}', full_id):
        raise ObserverRefusal('container_identity')
    if not proxy_full_id:
        if not full_id.startswith(proxy_id):
            raise ObserverRefusal('container_identity')
        proxy_full_id = full_id
    if full_id != proxy_full_id or container_name != '/' + proxy_name or \
            project != proxy_project or service != 'lares-egress-proxy':
        raise ObserverRefusal('container_ownership')
    if running is not True or not isinstance(init_pid, int) or init_pid <= 1:
        raise ObserverRefusal('container_not_running')
    if init is not True:
        raise ObserverRefusal('container_init')
    return {'id': full_id, 'init_pid': init_pid, 'running': True}


def _read_proxy_pidfile(container_id=None):
    identifier = container_id or proxy_full_id or proxy_id
    output = _observer_command('docker', 'exec', identifier, 'sh', '-c',
                               'for p in /run/squid.pid /run/squid/squid.pid; do '
                               'if [ -f "$p" ]; then cat "$p"; exit; fi; done; exit 1',
                               timeout=5, limit=128)
    if not re.fullmatch(r'[1-9][0-9]{0,8}', output):
        raise ObserverRefusal('pidfile_value')
    return int(output)


def _proc_identity(pid, proc_root='/proc'):
    if not isinstance(pid, int) or pid <= 0 or pid > 2**31 - 1:
        raise ObserverRefusal('pid_range')
    base = pathlib.Path(proc_root) / str(pid)
    status = parse_proc_status(_bounded_bytes(base / 'status', 8192))
    stat_data = parse_proc_stat(_bounded_bytes(base / 'stat', 8192))
    if stat_data['pid'] != pid or status['parent_pid'] != stat_data['parent_pid'] or \
            status['state'] != stat_data['state']:
        raise ObserverRefusal('process_identity')
    try:
        namespace = os.stat(base / 'ns/pid')
    except OSError as exc:
        safe = _safe_error(exc)
        raise ObserverRefusal(safe['category'], safe['errno']) from None
    return {'host_pid': pid, 'name_is_squid': status['name_is_squid'],
            'state': stat_data['state'], 'parent_pid': status['parent_pid'],
            'effective_uid': status['effective_uid'], 'nspids': status['nspids'],
            'starttime': stat_data['starttime'], 'namespace': (namespace.st_dev, namespace.st_ino)}


def _direct_children(init_pid, proc_root='/proc'):
    path = pathlib.Path(proc_root) / str(init_pid) / 'task' / str(init_pid) / 'children'
    data = _bounded_bytes(path, 4096)
    try:
        values = data.decode('ascii').split()
        if len(values) > 64 or any(not re.fullmatch(r'[1-9][0-9]{0,8}', value) for value in values):
            raise ObserverRefusal('children_list')
        result = [int(value) for value in values]
    except UnicodeDecodeError:
        raise ObserverRefusal('children_list') from None
    if len(set(result)) != len(result):
        raise ObserverRefusal('children_list')
    return result


def _snapshot_proxy_mapping(container_id, container_pid, proc_root='/proc'):
    container = _current_proxy_facts()
    if container['id'] != container_id:
        raise ObserverRefusal('container_identity')
    if _read_proxy_pidfile(container_id) != container_pid:
        raise ObserverRefusal('pidfile_changed')
    init_pid = container['init_pid']
    init = _proc_identity(init_pid, proc_root)
    if init['nspids'][0] != init_pid or init['nspids'][-1] != 1 or init['state'] in ('Z', 'X'):
        raise ObserverRefusal('init_namespace')
    children = _direct_children(init_pid, proc_root)
    candidates = []
    for child_pid in children:
        child = _proc_identity(child_pid, proc_root)
        if child['parent_pid'] == init_pid and child['nspids'][0] == child_pid and \
                child['nspids'][-1] == container_pid and child['namespace'] == init['namespace']:
            candidates.append(child)
    if len(candidates) != 1:
        raise ObserverRefusal('child_mapping')
    child = candidates[0]
    if not child['name_is_squid'] or child['state'] in ('Z', 'X', 'T', 't'):
        raise ObserverRefusal('squid_identity')
    identity = {'container_id': container['id'], 'init_pid': init_pid,
                'init_starttime': init['starttime'], 'init_namespace': init['namespace'],
                'child_pid': child['host_pid'], 'child_starttime': child['starttime'],
                'child_namespace': child['namespace'], 'container_pid': container_pid,
                'effective_uid': child['effective_uid']}
    return identity


def _fd9_stat(host_pid, proc_root='/proc'):
    try:
        return os.stat(pathlib.Path(proc_root) / str(host_pid) / 'fd/9')
    except OSError as exc:
        safe = _safe_error(exc)
        raise ObserverRefusal(safe['category'], safe['errno']) from None


def _read_fdinfo(host_pid, proc_root='/proc'):
    return _bounded_bytes(pathlib.Path(proc_root) / str(host_pid) / 'fdinfo/9', 4096)


def _fd_matches_gate(descriptor, gate_stat):
    return (descriptor.st_dev, descriptor.st_ino) == (gate_stat.st_dev, gate_stat.st_ino)


def _lock_matches_gate(lock, gate_stat):
    return (lock['dev_major'], lock['dev_minor'], lock['inode']) == (
        os.major(gate_stat.st_dev), os.minor(gate_stat.st_dev), gate_stat.st_ino)


def _fdinfo_inode_matches_gate(lock, before, after, gate_stat):
    inode = lock['fdinfo_inode']
    return inode == before.st_ino == after.st_ino == gate_stat.st_ino


def observe_proxy_lease(gate_path, container_pid, ops=None, expected_identity=None):
    ops = ops or {}
    local = ops.get('local_host', _verify_local_docker_host)
    facts = ops.get('container_facts', _current_proxy_facts)
    pidfile = ops.get('pidfile', _read_proxy_pidfile)
    mapping = ops.get('mapping', _snapshot_proxy_mapping)
    fd_stat = ops.get('fd_stat', _fd9_stat)
    fdinfo = ops.get('fdinfo', _read_fdinfo)
    exclusive = ops.get('host_exclusive', host_gate_exclusive_evidence)
    result = {'observed': False, 'refusal_category': None, 'refusal_errno': None,
              'fd9_same_gate_before': False, 'fd9_same_gate_after': False,
              'fd9_stable': False, 'fdinfo_readable': False, 'fdinfo_inode_matches': False,
              'fdinfo_metadata_inode_matches': False, 'fdinfo_lock_inode_matches': False,
              'lock_count': 0, 'single_flock': False, 'advisory_read': False,
              'write_absent': False, 'host_exclusive': None, 'identity_stable': False,
              'same_as_previous': None, 'host_pid': None, 'child_starttime': None,
              'effective_uid': None}
    try:
        local()
        initial_facts = facts()
        if initial_facts.get('id') != proxy_full_id or initial_facts.get('running') is not True:
            raise ObserverRefusal('container_identity')
        if pidfile(initial_facts['id']) != container_pid:
            raise ObserverRefusal('pidfile_changed')
        initial = mapping(initial_facts['id'], container_pid)
        result.update({'host_pid': initial['child_pid'], 'child_starttime': initial['child_starttime'],
                       'effective_uid': initial['effective_uid']})
        gate_stat = os.stat(gate_path, follow_symlinks=False)
        before = fd_stat(initial['child_pid'])
        result['fd9_same_gate_before'] = _fd_matches_gate(before, gate_stat)
        if not result['fd9_same_gate_before']:
            raise ObserverRefusal('fd9_inode')
        info = fdinfo(initial['child_pid'])
        result['fdinfo_readable'] = True
        lock = parse_gate_fdinfo(info)
        result.update({'lock_count': lock['lock_count'], 'single_flock': lock['single_flock'],
                       'advisory_read': lock['advisory_read'], 'write_absent': lock['write_absent'],
                       'fdinfo_lock_inode_matches': _lock_matches_gate(lock, gate_stat)})
        after = fd_stat(initial['child_pid'])
        result['fd9_same_gate_after'] = _fd_matches_gate(after, gate_stat)
        result['fd9_stable'] = (before.st_dev, before.st_ino) == (after.st_dev, after.st_ino)
        result['fdinfo_metadata_inode_matches'] = _fdinfo_inode_matches_gate(
            lock, before, after, gate_stat)
        result['fdinfo_inode_matches'] = result['fdinfo_metadata_inode_matches'] and \
            result['fdinfo_lock_inode_matches']
        if not result['fd9_same_gate_after'] or not result['fd9_stable'] or \
                not result['fdinfo_metadata_inode_matches'] or not result['fdinfo_lock_inode_matches']:
            raise ObserverRefusal('fd9_changed')
        host_result = exclusive(gate_path)
        result['host_exclusive'] = host_result
        if host_result.get('blocked') is not True or host_result.get('acquired') is not False:
            raise ObserverRefusal('host_lock_not_blocked', host_result.get('errno'))
        local()
        final_facts = facts()
        final = mapping(final_facts['id'], container_pid)
        result['identity_stable'] = final_facts == initial_facts and final == initial
        if not result['identity_stable']:
            raise ObserverRefusal('identity_changed')
        process_identity = (initial['child_pid'], initial['child_starttime'])
        result['same_as_previous'] = expected_identity is None or process_identity == expected_identity
        if result['same_as_previous'] is not True:
            raise ObserverRefusal('process_changed_during_reload')
        result['observed'] = result['single_flock'] and result['advisory_read'] and \
            result['write_absent'] and result['lock_count'] == 1
        if not result['observed']:
            raise ObserverRefusal('lock_shape')
    except ObserverRefusal as exc:
        result['refusal_category'] = exc.category
        result['refusal_errno'] = exc.errno
    except OSError as exc:
        safe = _safe_error(exc)
        result['refusal_category'] = safe['category']
        result['refusal_errno'] = safe['errno']
    except Exception:
        result['refusal_category'] = 'observer_error'
    return result


def assert_proxy_lease(gate_path, pid, label, preserve_process=False):
    global _serving_process_identity
    try:
        diagnostic = process_gate_evidence(pid, gate_path)
    except Exception as exc:
        safe = _safe_error(exc) if isinstance(exc, OSError) else {'category': 'other', 'errno': None}
        diagnostic = {'diagnostic_valid': False, 'observer_error_category': safe['category'],
                      'observer_error_errno': safe['errno']}
    expected_identity = _serving_process_identity if preserve_process else None
    host_evidence = observe_proxy_lease(gate_path, int(pid), expected_identity=expected_identity)
    report.setdefault('lease_diagnostics', []).append({
        'phase': label,
        'pid': int(pid) if str(pid).isdigit() else None,
        'container_observer': diagnostic,
        'host_observer': host_evidence,
    })
    check(label + ': same-host observer pins Squid, fd9 inode, and its single shared read lock',
          host_evidence['observed'] and host_evidence['identity_stable'] and
          host_evidence['fd9_same_gate_before'] and host_evidence['fd9_same_gate_after'] and
          host_evidence['fd9_stable'] and host_evidence['fdinfo_inode_matches'])
    check(label + ': host cannot acquire the exclusive gate while Squid serves',
          isinstance(host_evidence.get('host_exclusive'), dict) and
          host_evidence['host_exclusive'].get('blocked') is True and
          host_evidence['host_exclusive'].get('acquired') is False)
    if preserve_process:
        check(label + ': reload preserves the same pinned Squid process',
              _serving_process_identity is not None and host_evidence['same_as_previous'] is True and
              isinstance(_serving_process_identity, tuple) and len(_serving_process_identity) == 2)
    else:
        _serving_process_identity = (host_evidence['host_pid'], host_evidence['child_starttime']) \
            if host_evidence['observed'] else None


def _expect_refusal(callback, category):
    try:
        callback()
    except ObserverRefusal as exc:
        assert exc.category == category, (exc.category, category)
        return
    raise AssertionError('observer accepted a refused fixture case: ' + category)


def _fake_process(host_pid, parent_pid, nspids, namespace, *, name_is_squid=True,
                  starttime=300, effective_uid=31, state='S'):
    return {'host_pid': host_pid, 'parent_pid': parent_pid, 'nspids': list(nspids),
            'namespace': namespace, 'name_is_squid': name_is_squid, 'starttime': starttime,
            'effective_uid': effective_uid, 'state': state}


def _mapping_fixture(children=None, mutate=None, process_name=b'squid'):
    init_pid, container_pid = 100, 7
    init = _fake_process(init_pid, 1, [init_pid, 1], (4, 50), name_is_squid=False,
                         starttime=100)
    proc_status = b'Name:\t' + process_name + \
        b'\nState:\tS (sleeping)\nPPid:\t100\nUid:\t31\t31\t31\t31\nNSpid:\t101\t7\n'
    first = _fake_process(101, init_pid, [101, container_pid], (4, 50),
                          name_is_squid=parse_proc_status(proc_status)['name_is_squid'])
    second = _fake_process(102, init_pid, [102, container_pid], (4, 50), starttime=301)
    values = {init_pid: init, 101: first, 102: second}
    if mutate:
        values.update(mutate(values))
    with patch(__name__ + '._current_proxy_facts', return_value={
            'id': 'a' * 64, 'init_pid': init_pid, 'running': True}), \
            patch(__name__ + '._read_proxy_pidfile', return_value=container_pid), \
            patch(__name__ + '._direct_children', return_value=children if children is not None else [101]), \
            patch(__name__ + '._proc_identity', side_effect=lambda pid, proc_root='/proc': values[pid]):
        return _snapshot_proxy_mapping('a' * 64, container_pid)


def run_observer_self_tests():
    status = b'State:\tS (sleeping)\nPPid:\t100\nUid:\t31\t31\t31\t31\nNSpid:\t101\t7\n'
    assert parse_proc_status(b'Name:\tsquid\n' + status) == {
        'name_is_squid': True, 'state': 'S', 'parent_pid': 100, 'effective_uid': 31,
        'nspids': [101, 7]}
    for name in (b'squid worker', b'worker squid', b'squid-extra', b' squid', b'squid '):
        _expect_refusal(lambda value=name: _mapping_fixture(process_name=value), 'squid_identity')
    outer = ast.parse(pathlib.Path(__file__).read_text(encoding='utf-8'))
    diagnostic = next(node for node in outer.body
                      if isinstance(node, ast.FunctionDef) and node.name == 'process_gate_evidence')
    script_assignment = next(node for node in ast.walk(diagnostic) if isinstance(node, ast.Assign) and
                             any(isinstance(target, ast.Name) and target.id == 'script'
                                 for target in node.targets))
    ast.parse(ast.literal_eval(script_assignment.value))
    stat_fields = [b'S'] + [b'0'] * 19
    stat_fields[1] = b'12'
    stat_fields[19] = b'900'
    parsed_stat = parse_proc_stat(b'101 (squid (worker)) ' + b' '.join(stat_fields))
    assert parsed_stat == {'pid': 101, 'state': 'S', 'parent_pid': 12, 'starttime': 900}
    _expect_refusal(lambda: parse_proc_stat(b'101 (truncated) S 1'), 'malformed_stat')
    assert parse_gate_fdinfo(b'pos:\t0\nino:\t1234\n'
                             b'lock:\t1: FLOCK ADVISORY READ 101 08:01:1234 0 EOF\n')['fdinfo_inode'] == 1234
    padded_lock = b'lock:  1:   FLOCK  ADVISORY   READ  101  08:01:1234  0 EOF'
    legacy_lock_pattern = re.compile(
        r'lock:\s+\d+: FLOCK ADVISORY READ -?\d+ ([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+) 0 EOF')
    if legacy_lock_pattern.fullmatch(padded_lock.decode('ascii')) is not None:
        raise AssertionError('documented padded lock format did not reproduce the prior parser refusal')
    padded_result = parse_gate_fdinfo(b'ino: 1234\n' + padded_lock + b'\n')
    if padded_result != {'fdinfo_inode': 1234, 'dev_major': 8, 'dev_minor': 1, 'inode': 1234,
                         'single_flock': True, 'advisory_read': True, 'write_absent': True,
                         'lock_count': 1}:
        raise AssertionError('padded kernel lock record was not accepted')
    tabbed_lock = b'lock:\t1:\tFLOCK\tADVISORY\tREAD\t101\t08:01:1234\t0\tEOF'
    tabbed_result = parse_gate_fdinfo(b'ino: 1234\n' + tabbed_lock + b'\n')
    if tabbed_result != padded_result:
        raise AssertionError('tab-separated kernel lock record was not accepted')
    for lock_record in (b'lock: 1: FLOCK\vADVISORY READ 101 08:01:1234 0 EOF',
                        b'lock: 1: FLOCK\nADVISORY READ 101 08:01:1234 0 EOF',
                        b'lock: 1: FLOCK ADVISORY READ 101 08:01:1234 0 EOF extra'):
        _expect_refusal(lambda data=b'ino: 1234\n' + lock_record + b'\n':
                        parse_gate_fdinfo(data), 'lock_shape')
    _expect_refusal(lambda: parse_gate_fdinfo(
        b'ino: 1234\nlock: 1: FLOCK\xc2\xa0ADVISORY READ 101 08:01:1234 0 EOF\n'),
        'malformed_fdinfo')
    _expect_refusal(lambda: parse_gate_fdinfo(b'lock: 1: FLOCK ADVISORY READ 1 08:01:1234 0 EOF\n'),
                    'fdinfo_ino_count')
    _expect_refusal(lambda: parse_gate_fdinfo(b'ino: 1234\nino: 1234\n'
                                              b'lock: 1: FLOCK ADVISORY READ 1 08:01:1234 0 EOF\n'),
                    'fdinfo_ino_count')
    _expect_refusal(lambda: parse_gate_fdinfo(b'ino: 12x\n'
                                              b'lock: 1: FLOCK ADVISORY READ 1 08:01:1234 0 EOF\n'),
                    'fdinfo_ino_shape')
    for lock in (b'', b'lock: 1: FLOCK ADVISORY READ 1 08:01:1234 0 EOF\n'
                 b'lock: 2: FLOCK ADVISORY READ 1 08:01:1234 0 EOF\n',
                 b'lock: 1: FLOCK ADVISORY WRITE 1 08:01:1234 0 EOF\n',
                 b'lock: 1: POSIX ADVISORY READ 1 08:01:1234 0 EOF\n'):
        value = b'ino: 1234\n' + lock
        _expect_refusal(lambda data=value: parse_gate_fdinfo(data), 'lock_' +
                        ('count' if not lock or lock.count(b'lock:') != 1 else 'shape'))

    assert _mapping_fixture()['child_pid'] == 101
    _expect_refusal(lambda: _mapping_fixture(children=[101, 102]), 'child_mapping')
    _expect_refusal(lambda: _mapping_fixture(mutate=lambda values: {101: dict(values[101], parent_pid=99)}),
                    'child_mapping')
    _expect_refusal(lambda: _mapping_fixture(mutate=lambda values: {101: dict(values[101], nspids=[101, 8])}),
                    'child_mapping')
    _expect_refusal(lambda: _mapping_fixture(mutate=lambda values: {101: dict(values[101], namespace=(4, 51))}),
                    'child_mapping')
    _expect_refusal(lambda: _mapping_fixture(mutate=lambda values: {101: dict(values[101], name_is_squid=False)}),
                    'squid_identity')

    with tempfile.TemporaryDirectory(prefix='lares-egress-observer-test-') as temp:
        gate = pathlib.Path(temp) / 'service-gate.lock'
        gate.write_bytes(b'gate')
        gate_stat = os.stat(gate)
        lock_line = (f'ino: {gate_stat.st_ino}\n'
                     f'lock: 1: FLOCK ADVISORY READ 101 {os.major(gate_stat.st_dev):02x}:'
                     f'{os.minor(gate_stat.st_dev):02x}:{gate_stat.st_ino} 0 EOF\n').encode()
        pinned = {'id': 'a' * 64, 'init_pid': 100, 'running': True}
        identity = {'container_id': 'a' * 64, 'init_pid': 100, 'init_starttime': 100,
                    'init_namespace': (4, 50), 'child_pid': 101, 'child_starttime': 300,
                    'child_namespace': (4, 50), 'container_pid': 7, 'effective_uid': 31}

        def make_ops(*, facts_values=None, identities=None, fd_stats=None, fdinfo_value=lock_line,
                     exclusive_value=None, fd_stat_error=None):
            facts_values = list(facts_values or [pinned, pinned])
            identities = list(identities or [identity, identity])
            fd_stats = list(fd_stats or [gate_stat, gate_stat])
            return {
                'local_host': lambda: True,
                'container_facts': lambda: facts_values.pop(0),
                'pidfile': lambda _container: 7,
                'mapping': lambda _container, _pid: identities.pop(0),
                'fd_stat': lambda _pid: (_raise_observer(fd_stat_error) if fd_stat_error else fd_stats.pop(0)),
                'fdinfo': lambda _pid: fdinfo_value,
                'host_exclusive': lambda _path: exclusive_value or {
                    'blocked': True, 'acquired': False, 'error_category': None, 'errno': None},
            }

        global proxy_full_id
        previous_id = proxy_full_id
        proxy_full_id = 'a' * 64
        try:
            positive = observe_proxy_lease(gate, 7, make_ops())
            assert positive['observed'] and positive['identity_stable'] and positive['fd9_stable']
            assert positive['fdinfo_inode_matches'] and positive['host_exclusive']['blocked']
            _expect_observer_result(gate, make_ops(identities=[identity, dict(identity, child_starttime=301)]),
                                    'identity_changed')
            _expect_observer_result(gate, make_ops(facts_values=[pinned, dict(pinned, init_pid=101)]),
                                    'identity_changed')
            other_gate = pathlib.Path(temp) / 'replacement.lock'
            other_gate.write_bytes(b'other')
            _expect_observer_result(gate, make_ops(fd_stats=[gate_stat, os.stat(other_gate)]),
                                    'fd9_changed')
            _expect_observer_result(gate, make_ops(fd_stat_error=('permission', 13)), 'permission')
            for lock, category in (
                    (b'ino: 1234\nlock: 1: FLOCK ADVISORY WRITE 101 08:01:1234 0 EOF\n', 'lock_shape'),
                    (b'ino: 1234\nlock: 1: FLOCK ADVISORY READ 101 08:01:1234 0 EOF\n'
                     b'lock: 2: FLOCK ADVISORY READ 101 08:01:1234 0 EOF\n', 'lock_count')):
                _expect_observer_result(gate, make_ops(fdinfo_value=lock), category)
            wrong_inode = (f'ino: {gate_stat.st_ino}\n'
                           f'lock: 1: FLOCK ADVISORY READ 101 08:01:{gate_stat.st_ino + 1} 0 EOF\n').encode()
            _expect_observer_result(gate, make_ops(fdinfo_value=wrong_inode), 'fd9_changed')
            missing_ino = (f'lock: 1: FLOCK ADVISORY READ 101 {os.major(gate_stat.st_dev):02x}:'
                           f'{os.minor(gate_stat.st_dev):02x}:{gate_stat.st_ino} 0 EOF\n').encode()
            _expect_observer_result(gate, make_ops(fdinfo_value=missing_ino), 'fdinfo_ino_count')
            duplicate_ino = (f'ino: {gate_stat.st_ino}\nino: {gate_stat.st_ino}\n'
                             f'lock: 1: FLOCK ADVISORY READ 101 {os.major(gate_stat.st_dev):02x}:'
                             f'{os.minor(gate_stat.st_dev):02x}:{gate_stat.st_ino} 0 EOF\n').encode()
            _expect_observer_result(gate, make_ops(fdinfo_value=duplicate_ino), 'fdinfo_ino_count')
            malformed_ino = (f'ino: {gate_stat.st_ino}x\n'
                             f'lock: 1: FLOCK ADVISORY READ 101 {os.major(gate_stat.st_dev):02x}:'
                             f'{os.minor(gate_stat.st_dev):02x}:{gate_stat.st_ino} 0 EOF\n').encode()
            _expect_observer_result(gate, make_ops(fdinfo_value=malformed_ino), 'fdinfo_ino_shape')
            mismatched_metadata_ino = (f'ino: {gate_stat.st_ino + 1}\n'
                                       f'lock: 1: FLOCK ADVISORY READ 101 {os.major(gate_stat.st_dev):02x}:'
                                       f'{os.minor(gate_stat.st_dev):02x}:{gate_stat.st_ino} 0 EOF\n').encode()
            _expect_observer_result(gate, make_ops(fdinfo_value=mismatched_metadata_ino), 'fd9_changed')
            _expect_observer_result(gate, make_ops(exclusive_value={
                'blocked': False, 'acquired': True, 'error_category': None, 'errno': None}),
                'host_lock_not_blocked')
            _expect_observer_result(gate, make_ops(exclusive_value={
                'blocked': False, 'acquired': False, 'error_category': 'permission', 'errno': 13}),
                'host_lock_not_blocked')
            _expect_observer_result(gate, make_ops(), 'process_changed_during_reload',
                                    expected_identity=(999, 1))
        finally:
            proxy_full_id = previous_id
    print('egress host observer self-test passed')
    run_proxy_wait_diagnostic_self_tests()


def _raise_observer(details):
    raise ObserverRefusal(*details)


def _expect_observer_result(gate, ops, category, expected_identity=None):
    result = observe_proxy_lease(gate, 7, ops, expected_identity=expected_identity)
    assert result['observed'] is False and result['refusal_category'] == category, result


_PROXY_WAIT_STATES = {'created', 'running', 'restarting', 'paused', 'exited', 'dead'}
_PROXY_WAIT_ERRORS = {
    'EHOSTUNREACH': 'host_unreachable',
    'ENETUNREACH': 'network_unreachable',
    'ECONNREFUSED': 'connection_refused',
    'ECONNRESET': 'connection_reset',
    'ETIMEDOUT': 'timeout',
    'absolute-timeout': 'timeout',
    'inactivity-timeout': 'timeout',
    'oversized': 'oversized_response',
}


def _bounded_int(value, maximum):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum else None


def project_proxy_wait_diagnostic(response, expected_id, container_item, expected_network, expected_ip,
                                  phase, attempt, inspect_outcome='observed'):
    """Keep restart-wait evidence bounded to fixed fields and allowlisted values."""
    response = response if isinstance(response, dict) else {}
    status = _bounded_int(response.get('status'), 599)
    if status is not None and status < 100:
        status = None
    raw_error = response.get('error')
    if isinstance(raw_error, str) and raw_error in _PROXY_WAIT_ERRORS:
        socket_category = _PROXY_WAIT_ERRORS[raw_error]
    elif raw_error is None and status is not None:
        socket_category = 'http_response'
    elif raw_error is None and not response:
        socket_category = 'request_failed'
    else:
        socket_category = 'other_socket_error'

    item = container_item if isinstance(container_item, dict) else {}
    observed_id = item.get('Id')
    if not isinstance(observed_id, str) or not observed_id:
        identity_category = 'missing'
    elif not isinstance(expected_id, str) or not expected_id:
        identity_category = 'expected_id_missing'
    elif observed_id == expected_id:
        identity_category = 'matched'
    else:
        identity_category = 'mismatched'

    state = item.get('State')
    if not isinstance(state, dict):
        state = {}
        state_category = 'missing' if 'State' not in item else 'malformed'
    else:
        raw_state = state.get('Status')
        state_category = raw_state if isinstance(raw_state, str) and raw_state in _PROXY_WAIT_STATES else (
            'missing' if raw_state is None else 'other')

    settings = item.get('NetworkSettings')
    networks = settings.get('Networks') if isinstance(settings, dict) else None
    if not isinstance(networks, dict):
        network_attached = False
        ip_matches = False
    else:
        endpoint = networks.get(expected_network)
        network_attached = isinstance(endpoint, dict)
        ip_matches = network_attached and endpoint.get('IPAddress') == expected_ip

    bounded_attempt = _bounded_int(attempt, 30)
    return {
        'phase': phase if phase == 'docker_restart' else 'other',
        'attempt': bounded_attempt if bounded_attempt and bounded_attempt >= 1 else None,
        'socket_category': socket_category,
        'status': status,
        'greeting': response.get('greeting') is True,
        'container_id_match': identity_category == 'matched',
        'container_identity': identity_category,
        'inspect_outcome': inspect_outcome if inspect_outcome in (
            'observed', 'failed', 'not_attempted') else 'other',
        'state': state_category,
        'running': state.get('Running') if type(state.get('Running')) is bool else None,
        'exit_code': _bounded_int(state.get('ExitCode'), 255),
        'pid': _bounded_int(state.get('Pid'), 2147483647),
        'expected_network_attached': network_attached,
        'expected_proxy_ip_matches': ip_matches,
    }


def _record_proxy_wait_diagnostic(response, phase, attempt, container_item=None,
                                  inspect_outcome='observed'):
    records = report.setdefault('proxy_wait_diagnostics', [])
    if len(records) >= 30:
        return
    records.append(project_proxy_wait_diagnostic(
        response, proxy_id, container_item, network, proxy_ip, phase, attempt, inspect_outcome))


def run_proxy_wait_diagnostic_self_tests():
    global action, network, proxy_id, proxy_ip, report, result
    keys = ('action', 'network', 'proxy_id', 'proxy_ip', 'report', 'result')
    saved = {key: (key in globals(), globals().get(key)) for key in keys}
    try:
        action = 'offline proxy wait self-test'
        network, proxy_id, proxy_ip = 'fixture-network', 'a' * 64, '10.0.0.13'
        report = {'checks': [], 'success': False}
        failed_response = {'status': None, 'greeting': False, 'error': 'EHOSTUNREACH'}
        ready_response = {'status': 200, 'greeting': True, 'error': None}
        ready_container = {
            'Id': proxy_id,
            'State': {'Status': 'running', 'Running': True, 'ExitCode': 0, 'Pid': 2},
            'NetworkSettings': {'Networks': {network: {'IPAddress': proxy_ip}}},
        }
        with patch(__name__ + '.request', side_effect=[failed_response, ready_response]), \
                patch(__name__ + '.inspect_container', return_value=ready_container), \
                patch(__name__ + '.time.sleep') as sleep:
            wait_for_proxy(diagnostic_phase='docker_restart')
        if sleep.call_count != 1:
            raise AssertionError('failed response did not preserve the existing one-poll sleep')
        positive = report['proxy_wait_diagnostics']
        if len(positive) != 1 or positive[0] != {
                'phase': 'docker_restart', 'attempt': 1,
                'socket_category': 'host_unreachable', 'status': None, 'greeting': False,
                'container_id_match': True, 'container_identity': 'matched',
                'inspect_outcome': 'observed', 'state': 'running', 'running': True,
                'exit_code': 0, 'pid': 2, 'expected_network_attached': True,
                'expected_proxy_ip_matches': True}:
            raise AssertionError('positive failed-attempt diagnostic was not projected as expected')

        report = {'checks': [], 'success': False}
        missing_identity = {'State': {'Status': 'created', 'Running': False,
                                      'ExitCode': 256, 'Pid': 'unbounded'},
                            'NetworkSettings': {'Networks': {'other-secret-network': {}}}}
        with patch(__name__ + '.request', return_value=failed_response), \
                patch(__name__ + '.inspect_container', return_value=missing_identity), \
                patch(__name__ + '.time.sleep') as sleep:
            try:
                wait_for_proxy(diagnostic_phase='docker_restart')
            except RuntimeError as exc:
                if str(exc) != action:
                    raise AssertionError('non-running refusal changed') from exc
            else:
                raise AssertionError('non-running proxy was accepted')
        missing = report['proxy_wait_diagnostics'][0]
        if missing['container_identity'] != 'missing' or missing['container_id_match'] or \
                missing['running'] is not False or missing['state'] != 'created' or \
                missing['exit_code'] is not None or missing['pid'] is not None or \
                missing['expected_network_attached'] or missing['expected_proxy_ip_matches'] or \
                sleep.called:
            raise AssertionError('missing/malformed identity evidence was not safely bounded')

        malformed = project_proxy_wait_diagnostic(
            {'status': '200', 'greeting': 'yes', 'error': 'private raw diagnostic'},
            proxy_id, {'Id': 'secret-id', 'State': {'Status': 'secret-state', 'Running': 'yes',
                                                     'ExitCode': 999999, 'Pid': -1},
                       'NetworkSettings': {'Networks': {'fixture-network': 'secret'}}},
            network, proxy_ip, 'docker_restart', 1)
        encoded = json.dumps(malformed, sort_keys=True)
        if malformed != {
                'phase': 'docker_restart', 'attempt': 1,
                'socket_category': 'other_socket_error', 'status': None, 'greeting': False,
                'container_id_match': False, 'container_identity': 'mismatched',
                'inspect_outcome': 'observed', 'state': 'other', 'running': None,
                'exit_code': None, 'pid': None, 'expected_network_attached': False,
                'expected_proxy_ip_matches': False} or any(
                    value in encoded for value in ('private raw diagnostic', 'secret-id', 'secret-state')):
            raise AssertionError('diagnostic projection retained malformed or private source values')

        report = {'checks': [], 'success': False}
        with patch(__name__ + '.request', return_value=failed_response), \
                patch(__name__ + '.inspect_container', side_effect=RuntimeError('private inspect text')):
            try:
                wait_for_proxy(diagnostic_phase='docker_restart')
            except RuntimeError as exc:
                if str(exc) != 'private inspect text':
                    raise
            else:
                raise AssertionError('inspect failure did not preserve the original refusal')
        if report['proxy_wait_diagnostics'][0]['inspect_outcome'] != 'failed' or \
                'private inspect text' in json.dumps(report['proxy_wait_diagnostics']):
            raise AssertionError('inspect error was not recorded with fixed redacted evidence')

        report = {'checks': [], 'success': False}
        with patch(__name__ + '.request', side_effect=RuntimeError('private request text')):
            try:
                wait_for_proxy(diagnostic_phase='docker_restart')
            except RuntimeError as exc:
                if str(exc) != 'private request text':
                    raise
            else:
                raise AssertionError('request failure did not preserve the original refusal')
        if report['proxy_wait_diagnostics'][0]['socket_category'] != 'request_failed' or \
                report['proxy_wait_diagnostics'][0]['inspect_outcome'] != 'not_attempted':
            raise AssertionError('request exception was not recorded as a fixed category')

        report = {'checks': [], 'success': False}
        running_container = dict(ready_container, State={'Status': 'running', 'Running': True})
        with patch(__name__ + '.request', return_value=failed_response), \
                patch(__name__ + '.inspect_container', return_value=running_container), \
                patch(__name__ + '.time.sleep'):
            try:
                wait_for_proxy(diagnostic_phase='docker_restart')
            except RuntimeError as exc:
                if str(exc) != action:
                    raise AssertionError('wait timeout refusal changed') from exc
            else:
                raise AssertionError('bounded waiter accepted a proxy without a successful response')
        if len(report['proxy_wait_diagnostics']) != 30 or [
                record['attempt'] for record in report['proxy_wait_diagnostics']] != list(range(1, 31)) or any(
                record['phase'] != 'docker_restart' or
                record['socket_category'] != 'host_unreachable'
                for record in report['proxy_wait_diagnostics']):
            raise AssertionError('wait diagnostics did not stay within the existing 30-attempt bound')
    finally:
        for key, (existed, value) in saved.items():
            if existed:
                globals()[key] = value
            else:
                globals().pop(key, None)
    print('egress proxy restart-wait diagnostic self-test passed')


def wait_for_proxy(diagnostic_phase=None):
    global result
    if diagnostic_phase not in (None, 'docker_restart'):
        raise ValueError('unsupported proxy wait diagnostic phase')
    for _attempt in range(30):
        try:
            result = request(connect())
        except Exception:
            if diagnostic_phase is not None:
                _record_proxy_wait_diagnostic(None, diagnostic_phase, _attempt + 1,
                                              inspect_outcome='not_attempted')
            raise
        if result['status'] == 200 and result['greeting']:
            return
        try:
            item = inspect_container(proxy_id)
        except Exception:
            if diagnostic_phase is not None:
                _record_proxy_wait_diagnostic(result, diagnostic_phase, _attempt + 1,
                                              inspect_outcome='failed')
            raise
        if diagnostic_phase is not None:
            _record_proxy_wait_diagnostic(result, diagnostic_phase, _attempt + 1, item)
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
    assert_proxy_lease(gate_path, proxy_pid(), 'After reload', preserve_process=True)
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
    assert_proxy_lease(gate_path, proxy_pid(), 'After restore reload', preserve_process=True)
    sockets = cmd('docker', 'exec', proxy_id, 'sh', '-c', 'cat /proc/net/udp /proc/net/udp6')
    check('ICP and HTCP have no UDP listener', not re.search(r':(?:0C3A|12DB)\s', sockets))

    action = 'prove the same Squid gate descriptor survives Docker restart'
    container_before_restart = proxy_id
    compose('restart', 'lares-egress-proxy')
    wait_for_proxy(diagnostic_phase='docker_restart')
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


if _self_test:
    run_observer_self_tests()
    raise SystemExit(0)


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
