"""Small, probe-only helpers. No recursive deletion; no OS sandbox claim."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

class ProbeError(RuntimeError):
    pass

def require(condition, message):
    if not condition:
        raise ProbeError(message)

def validate_label(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', value) is not None,
            'label must contain 1-64 ASCII letters, digits, underscores or hyphens')
    return value

def plain_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and not getattr(info, 'st_file_attributes', 0) & 0x400,
            'refusing a symlink, junction, reparse point or non-directory')

def safe_directory(root, parts):
    root = root.resolve(strict=True)
    plain_directory(root)
    current = root
    for part in parts:
        require(part not in ('', '.', '..') and '/' not in part and '\\' not in part, 'invalid path component')
        current = current / part
        try:
            current.mkdir()
        except FileExistsError:
            pass
        plain_directory(current)
        require(current.resolve(strict=True).is_relative_to(root), 'directory escapes root')
    return current

def atomic_json(path, value):
    # A failed write leaves the previous RUNNING manifest, never a partial SUCCESS.
    temporary = path.with_name('.manifest-' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=True, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)

def minimal_environment(node, home, temporary=None):
    allowed = {'systemroot', 'windir', 'comspec', 'pathext'}
    env = {k.upper(): v for k, v in os.environ.items() if k.lower() in allowed}
    # No inherited PATH, HOME, APPDATA, NODE_OPTIONS or credentials. Filesystem
    # access still follows the user's OS permissions; this is not confinement.
    paths = [str(Path(node).resolve().parent), str(Path(sys.executable).resolve().parent)]
    git = shutil.which('git')
    if git:
        paths.append(str(Path(git).resolve().parent))
    if os.name == 'nt':
        system = Path(env.get('SYSTEMROOT', r'C:\Windows'))
        paths.extend([str(system/'System32'), str(system), str(system/'System32/WindowsPowerShell/v1.0')])
    else:
        paths.extend(['/usr/bin', '/bin'])
    temporary = temporary or home
    env.update(PATH=os.pathsep.join(paths), HOME=str(home), USERPROFILE=str(home),
               APPDATA=str(home), LOCALAPPDATA=str(home), TMP=str(temporary), TEMP=str(temporary),
               TMPDIR=str(temporary), NO_COLOR='1', DOTENV_CONFIG_PATH=str(home/'disabled.env'))
    return env

class _WindowsJob:
    """A gated child joins this private job before it can spawn Node/workers."""
    def __init__(self):
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                        ('flags', w.DWORD), ('min_ws', ctypes.c_size_t), ('max_ws', ctypes.c_size_t),
                        ('active', w.DWORD), ('affinity', ctypes.c_size_t),
                        ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', ctypes.c_uint64*6),
                        ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                        ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.api.CreateJobObjectW.restype = w.HANDLE
        self.api.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.api.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        self.api.OpenProcess.restype = w.HANDLE
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        require(bool(self.handle), 'cannot create owned process job')
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ProbeError('cannot configure owned process job')
    def assign(self, process):
        handle = self.api.OpenProcess(0x0100 | 0x0001, False, process.pid)
        require(bool(handle), 'cannot open owned gated process')
        try:
            require(bool(self.api.AssignProcessToJobObject(self.handle, handle)), 'cannot assign owned process job')
        finally:
            self.api.CloseHandle(handle)
    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None

def owned_process(command, cwd, env, log, timeout=120):
    """Own only this gated launcher and its descendants; close their job/group.
    POSIX descendants that deliberately create a different session are outside
    this cooperative test-runner guarantee. No process-name or broad PID kill.
    """
    job = _WindowsJob() if os.name == 'nt' else None
    process = None
    try:
        with Path(log).open('x', encoding='utf-8') as output:
            process = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()),
                                        '--owned-child', *map(str, command)],
                                       cwd=cwd, env=env, stdin=subprocess.PIPE,
                                       stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=os.name != 'nt',
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            if job:
                job.assign(process)
            process.stdin.write(b'GO\n')
            process.stdin.flush()
            try:
                return process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                raise ProbeError('owned process timed out') from error
    finally:
        if job:
            job.close()  # Also terminates descendants after normal launcher exit.
        elif process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdin and not process.stdin.closed:
                process.stdin.close()

class EvidenceRun:
    def __init__(self, root, label, mode, node):
        validate_label(label)
        require(mode in ('candidate', 'baseline'), 'invalid mode')
        self.root = Path(root).resolve(strict=True)
        parent = safe_directory(self.root, ['.cache', 'story2', 'runs'])
        self.path = Path(tempfile.mkdtemp(prefix='run-', dir=parent))
        self.id = self.path.name
        self.manifest = {'schema':2, 'runId':self.id, 'label':label, 'mode':mode,
                         'state':'RUNNING', 'remediation':False, 'steps':[]}
        self.home = safe_directory(self.path, ['home'])
        self.temporary = Path(tempfile.mkdtemp(prefix='magicast-owned-'))
        self.env = minimal_environment(node, self.home, self.temporary)
        self.publish()
    def verify(self):
        relative = self.path.relative_to(self.root)
        current = self.root
        for part in relative.parts:
            current = current/part
            plain_directory(current)
    def publish(self):
        self.verify()
        atomic_json(self.path/'manifest.json', self.manifest)
    def write(self, name, content):
        self.verify()
        require('/' not in name and '\\' not in name and name not in ('', '.', '..'), 'invalid artifact name')
        with (self.path/name).open('x', encoding='utf-8') as stream:
            stream.write(content)
    def command(self, name, command, cwd=None, timeout=120):
        validate_label(name)
        self.verify()
        code = owned_process(command, cwd or self.path, self.env, self.path/(name+'.log'), timeout)
        self.manifest['steps'].append({'name':name,'exit':code})
        self.publish()
        require(code == 0, 'step failed: '+name)
    def finish(self, results):
        self.verify()
        self.manifest['results'] = results
        self.manifest['artifacts'] = {
            p.name:hashlib.sha256(p.read_bytes()).hexdigest()
            for p in self.path.iterdir() if p.is_file() and p.name != 'manifest.json'
        }
        for directory in ('baseline-coverage','candidate-coverage','coverage-forks','coverage-threads'):
            for name in ('coverage-final.json','coverage-summary.json'):
                file=self.path/directory/name
                if file.exists():
                    self.manifest['artifacts'][directory+'/'+name]=hashlib.sha256(file.read_bytes()).hexdigest()
        self.manifest['state'] = 'SUCCESS' if self.manifest['mode']=='candidate' else 'BASELINE_CHARACTERIZED'
        self.manifest['remediation'] = self.manifest['mode']=='candidate'
        self.publish()
    def fail(self, error):
        self.manifest['state'] = 'FAILED'
        self.manifest['remediation'] = False
        self.manifest['error'] = type(error).__name__  # No local paths/env/error contents.
        self.publish()

def _posix_owned_child(command):
    # Monitor the ownership pipe on this thread. A daemon blocked in Python's
    # buffered stdin can abort interpreter finalization after a normal exit.
    import select
    descriptor=sys.stdin.fileno()
    with subprocess.Popen(command,stdin=subprocess.DEVNULL) as child:
        while True:
            readable,_,_=select.select([descriptor],[],[],.05)
            if readable and not os.read(descriptor,4096):
                # owned_process gave this launcher its own session/group.
                os.killpg(os.getpgrp(),signal.SIGKILL)
            code=child.poll()
            if code is not None:
                return code


if __name__ == '__main__':
    if len(sys.argv)<3 or sys.argv[1]!='--owned-child' or sys.stdin.buffer.readline()!=b'GO\n':
        sys.exit(2)
    if os.name != 'nt':
        sys.exit(_posix_owned_child(sys.argv[2:]))
    sys.exit(subprocess.call(sys.argv[2:], stdin=subprocess.DEVNULL))
