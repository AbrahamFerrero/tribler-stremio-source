"""Synthetic regressions for omitted export files and stale/incomplete QA evidence."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
from magicast_collect import EXPECTED_STEPS, verify
from magicast_evidence import COVERAGE_FILES, PROBE_FILES, PROBE_STEPS, comparable, prepare_export, source_inputs, tool_inputs
from magicast_reproduce import BASE, DEADLINE_PATCH
from magicast_support import ProbeError, minimal_environment

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]

class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='qa-integrity-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.env=minimal_environment(sys.executable,self.root)
    def git(self,root,*args):
        return subprocess.check_output(['git','-C',str(root),*args],env=self.env)
    def init(self,root):
        root.mkdir();self.git(root,'init','-q')
    def write(self,root,name,value):
        file=root/name;file.parent.mkdir(parents=True,exist_ok=True)
        file.write_bytes((json.dumps(value) if not isinstance(value,str) else value).encode('utf-8'))
    def fixture(self):
        current=self.root/'current';self.init(current)
        files={'.gitignore':'__pycache__/\n.cache/\n', 'package-lock.json':json.dumps({'packages':{}}),
               'src/synthetic.ts':'export const synthetic = 1;',
               'docs/qa/synthetic.py':'# synthetic QA tool\n',
               **{name:'// synthetic common patch\n' for name in DEADLINE_PATCH}}
        for name,value in files.items():self.write(current,name,value)
        prepare_export(current)
        run=self.root/'run-synthetic';run.mkdir()
        inputs=source_inputs(current)
        reference={'originSha':BASE,'kind':'corrected-reference','patchSha256':{name:inputs[name] for name in DEADLINE_PATCH}}
        results=dict(node='v20.19.0',base=BASE,lockSha256=inputs['package-lock.json'],
                     reference=reference,exports={'baseline':inputs,'candidate':inputs},
                     toolHashes=tool_inputs(current),coverageFiles=1,mapsIdentical=True,
                     syntheticMapsAndCountersIdentical=True,counterDifferences=[],productionEntries=0,artifact={'node':'v20.19.0'})
        for kind in ('baseline','candidate'):
            source=run/(kind+'-source');self.init(source)
            for name,value in files.items():self.write(source,name,value)
            prepare_export(source)
            coverage={str(source/'src/synthetic.ts'):{'path':str(source/'src/synthetic.ts'),
                       'statementMap':{},'fnMap':{},'branchMap':{},'s':{},'f':{},'b':{}}}
            self.write(run,kind+'-coverage/coverage-final.json',coverage)
            self.write(run,kind+'-coverage/coverage-summary.json',{'total':{'synthetic':1}})
            results[kind+'Summary']={'synthetic':1}
            relative='.cache/story2/runs/probe-'+kind+'/manifest.json'
            probe_root=(source/relative).parent;probe_root.mkdir(parents=True)
            for name in PROBE_FILES:self.write(probe_root,name,'synthetic artifact')
            probe=dict(runId='probe-'+kind,state='SUCCESS' if kind=='candidate' else 'BASELINE_CHARACTERIZED',
                       remediation=kind=='candidate',steps=[{'name':n,'exit':0} for n in sorted(PROBE_STEPS)],
                       artifacts={n:hashlib.sha256((probe_root/n).read_bytes()).hexdigest() for n in PROBE_FILES},
                       inputs={'tools':tool_inputs(current),'lockSha256':inputs['package-lock.json']},
                       results={'artifact':{'node':'v20.19.0'},'coverage':[]})
            self.write(probe_root,'manifest.json',probe)
            results[kind+'Probe']={k:probe[k] for k in ('runId','state')}
            self.write(run,kind+'-probe.log',json.dumps({'manifest':relative,**results[kind+'Probe']}))
        for name in EXPECTED_STEPS-{'baseline-probe','candidate-probe'}:self.write(run,name+'.log','synthetic log')
        for name in ('npm-user.conf','npm-global.conf'):self.write(run,name,'')
        self.write(run,'provenance.json',{'exports':results['exports'],'reference':reference})
        manifest=dict(state='SUCCESS',remediation=True,runId=run.name,reference=reference,
                      steps=[{'name':n,'exit':0} for n in sorted(EXPECTED_STEPS)],results=results,
                      artifacts={p.relative_to(run).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in run.rglob('*') if p.is_file() and ('-source' not in p.relative_to(run).parts[0])})
        path=run/'manifest.json';self.write(run,path.name,manifest)
        archive=io.BytesIO()
        with tarfile.open(fileobj=archive,mode='w') as tar:
            for name,value in files.items():
                data=value.encode();info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
        import magicast_reproduce
        original=magicast_reproduce.git
        def public_git(root,*args):
            if args[0]=='archive':return archive.getvalue()
            return original(root,*args)
        self.mock=self.enterContext(patch('magicast_reproduce.git',side_effect=public_git))
        return current,path,manifest
    def save(self,path,manifest):self.write(path.parent,path.name,manifest)
    def test_ignored_credential_is_indexed_and_gate_fails_then_passes(self):
        repo=self.root/'export';self.init(repo)
        self.write(repo,'.gitignore','ignored.txt\n');self.write(repo,'public.txt','synthetic public file')
        self.write(repo,'ignored.txt','ghp_'+'X'*36)
        before=set(self.git(repo,'ls-files','--others','--exclude-standard').decode().splitlines())
        self.assertEqual(before,{'.gitignore','public.txt'})
        command=[shutil.which('node'),str(ROOT/'node_modules/tsx/dist/cli.mjs'),str(ROOT/'scripts/check-repository-safety.ts'),'--all']
        self.assertEqual(subprocess.run(command,cwd=repo,env=self.env,capture_output=True).returncode,0)
        self.assertEqual(set(prepare_export(repo)),{'.gitignore','public.txt','ignored.txt'})
        result=subprocess.run(command,cwd=repo,env=self.env,capture_output=True)
        self.assertEqual(result.returncode,1);self.assertIn(b'ignored.txt: high-confidence credential',result.stderr)
        (repo/'ignored.txt').unlink();self.git(repo,'add','--update')
        self.assertEqual(subprocess.run(command,cwd=repo,env=self.env,capture_output=True).returncode,0)
    def test_complete_synthetic_contract_is_accepted(self):
        current,path,_=self.fixture()
        self.assertEqual(verify(path,current)['runtime'],'v20.19.0')
    def test_manifest_without_artifacts_rejected(self):
        current,path,m=self.fixture();m['artifacts']={};self.save(path,m)
        with self.assertRaisesRegex(ProbeError,'mandatory'):verify(path,current)
    def test_missing_mandatory_log_rejected_even_if_hash_removed(self):
        current,path,m=self.fixture();(path.parent/'candidate-test.log').unlink();del m['artifacts']['candidate-test.log'];self.save(path,m)
        with self.assertRaisesRegex(ProbeError,'mandatory'):verify(path,current)
    def test_altered_artifact_rejected(self):
        current,path,_=self.fixture();self.write(path.parent,'candidate-test.log','altered')
        with self.assertRaisesRegex(ProbeError,'changed'):verify(path,current)
    def test_candidate_changed_after_qa_rejected(self):
        current,path,_=self.fixture();self.write(current,'src/synthetic.ts','modified candidate')
        with self.assertRaisesRegex(ProbeError,'current candidate'):verify(path,current)
    def test_qa_changed_after_evidence_rejected(self):
        current,path,_=self.fixture();self.write(current,'docs/qa/synthetic.py','# modified QA')
        with self.assertRaisesRegex(ProbeError,'current candidate'):verify(path,current)
    def test_reference_incompatibility_rejected(self):
        current,path,m=self.fixture();m['results']['reference']={**m['reference'],'kind':'historical-exact'};self.save(path,m)
        with self.assertRaisesRegex(ProbeError,'reference'):verify(path,current)
    def test_cross_runtime_reference_and_export_mismatch_rejected(self):
        _,_,m=self.fixture();a={'runtime':'v20.19.0','reference':m['reference'],'exports':m['results']['exports']}
        b={**a,'runtime':'v22.23.2'};comparable([a,b])
        with self.assertRaisesRegex(ProbeError,'references'):comparable([a,{**b,'reference':{'kind':'historical-exact'}}])
        with self.assertRaisesRegex(ProbeError,'export'):comparable([a,{**b,'exports':{}}])
    def test_gate_missing_or_duplicated_rejected(self):
        current,path,m=self.fixture()
        for steps in (m['steps'][:-1],m['steps']+[m['steps'][0]]):
            self.save(path,{**m,'steps':steps})
            with self.assertRaisesRegex(ProbeError,'gates'):verify(path,current)
    def test_running_and_failed_rejected(self):
        current,path,m=self.fixture()
        for state in ('RUNNING','FAILED'):
            self.save(path,{**m,'state':state})
            with self.assertRaisesRegex(ProbeError,'incomplete'):verify(path,current)

class CoveragePathTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='coverage canonical synthetic ')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.source=self.root/'allowed snapshot';self.source.mkdir()
        self.file=self.source/'synthetic.ts';self.file.write_text('// synthetic')
        self.report=self.root/'report';self.report.mkdir()

    def coverage(self, filename):
        (self.report/'coverage-final.json').write_text(json.dumps({str(filename):{'path':str(filename),'s':{}}}))

    def test_canonical_source_and_file_are_used(self):
        from magicast_reproduce import normalized_coverage
        self.coverage(self.source/'..'/self.source.name/self.file.name)
        self.assertEqual(set(normalized_coverage(self.source,self.report)),{'synthetic.ts'})

    def test_outside_snapshot_and_sibling_prefix_are_rejected(self):
        from magicast_reproduce import normalized_coverage
        outside=self.root/(self.source.name+' sibling');outside.mkdir()
        file=outside/'synthetic.ts';file.write_text('// synthetic outside')
        for path in (file,self.source/'..'/outside.name/file.name):
            with self.subTest(path=path):
                self.coverage(path)
                with self.assertRaises((ProbeError,ValueError)):normalized_coverage(self.source,self.report)

    def test_symlink_cannot_escape_real_snapshot(self):
        from magicast_reproduce import normalized_coverage
        outside=self.root/'outside';outside.mkdir()
        file=outside/'synthetic.ts';file.write_text('// synthetic outside')
        link=self.source/'escape'
        if sys.platform=='win32':
            import os
            env={**minimal_environment(sys.executable,self.root),'MAGICAST_LINK':str(link),'MAGICAST_TARGET':str(outside)}
            powershell=Path(os.environ['SYSTEMROOT'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
            result=subprocess.run([str(powershell),'-NoProfile','-NonInteractive','-Command',
                'New-Item -ItemType Junction -Path $env:MAGICAST_LINK -Target $env:MAGICAST_TARGET -ErrorAction Stop | Out-Null'],env=env,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace'))
            self.addCleanup(link.rmdir)  # Remove the owned junction, never its target.
        else:
            link.symlink_to(outside,target_is_directory=True)
            self.addCleanup(link.unlink)
        self.coverage(link/file.name)
        with self.assertRaises(ProbeError):normalized_coverage(self.source,self.report)

    def test_duplicate_canonical_files_are_rejected(self):
        from magicast_reproduce import normalized_coverage
        sub=self.source/'sub';sub.mkdir()
        alias=sub/'..'/self.file.name
        (self.report/'coverage-final.json').write_text(json.dumps({str(self.file):{'path':str(self.file)},str(alias):{'path':str(alias)}}))
        with self.assertRaisesRegex(ProbeError,'duplicate canonical'):normalized_coverage(self.source,self.report)

    @unittest.skipUnless(sys.platform=='win32','Windows 8.3 alias test')
    def test_windows_short_alias_is_canonical_and_contained(self):
        import ctypes
        from ctypes import wintypes
        from magicast_reproduce import normalized_coverage
        api=ctypes.WinDLL('kernel32',use_last_error=True)
        api.GetShortPathNameW.argtypes=[wintypes.LPCWSTR,wintypes.LPWSTR,wintypes.DWORD]
        api.GetShortPathNameW.restype=wintypes.DWORD
        buf=ctypes.create_unicode_buffer(32768)
        self.assertTrue(api.GetShortPathNameW(str(self.source),buf,len(buf)))
        alias=Path(buf.value)
        if alias==self.source:self.skipTest('8.3 aliases unavailable on this volume')
        self.assertEqual(alias.resolve(strict=True),self.source.resolve(strict=True))
        self.coverage(alias/self.file.name)
        self.assertEqual(set(normalized_coverage(self.source,self.report)),{'synthetic.ts'})
        self.coverage(self.file)
        self.assertEqual(set(normalized_coverage(alias,self.report)),{'synthetic.ts'})

if __name__=='__main__':unittest.main()
