"""Adversarial tests of the QA runner, using owned synthetic directories only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from magicast_support import EvidenceRun, ProbeError, minimal_environment, owned_process, safe_directory, validate_label
spec=importlib.util.spec_from_file_location('magicast_probe',HERE/'v1.5.2-magicast-probe.py')
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
ROOT=HERE.parents[1]
NODE=os.environ.get('MAGICAST_TEST_NODE') or __import__('shutil').which('node')

class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='magicast-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        self.home=self.root/'home';self.home.mkdir()
    def test_bad_labels_rejected_before_any_writes(self):
        sentinel=self.root/'outside-synthetic-forks';sentinel.mkdir()
        keep=sentinel/'keep.txt';keep.write_text('placeholder-sentinel')
        for label in ['', '..','../outside','../../docs/review','a/b','a\\b','C:\\temp','a b','a\n','ñ','x'*65]:
            with self.subTest(label=label), self.assertRaises(ProbeError):
                EvidenceRun(self.root,label,'candidate',sys.executable)
        self.assertEqual(keep.read_text(),'placeholder-sentinel')
        self.assertFalse((self.root/'.cache').exists())
    def test_labels_are_metadata_and_modes_are_explicit(self):
        for label in ['release','baseline','candidate','CASE_123']:
            run=EvidenceRun(self.root,label,'candidate',sys.executable)
            self.assertNotIn(label,run.path.name)
            self.assertEqual(run.manifest['mode'],'candidate')
            self.assertFalse(run.manifest['remediation'])
        with self.assertRaises(ProbeError):EvidenceRun(self.root,'valid','',sys.executable)
    def test_symlink_parent_is_rejected(self):
        target=self.root/'outside';target.mkdir();(target/'keep').write_text('placeholder')
        link=self.root/'.cache'
        try:link.symlink_to(target,target_is_directory=True)
        except OSError as error:self.skipTest('directory symlink unavailable: '+type(error).__name__)
        with self.assertRaises(ProbeError):EvidenceRun(self.root,'valid','candidate',sys.executable)
        self.assertEqual(list(target.iterdir()),[target/'keep'])
    @unittest.skipUnless(os.name=='nt','Windows junction test')
    def test_windows_junction_parent_is_rejected(self):
        target=self.root/'outside space ñ';target.mkdir();(target/'keep').write_text('placeholder')
        link=self.root/'.cache'
        env={**minimal_environment(sys.executable,self.home),'MAGICAST_LINK':str(link),'MAGICAST_TARGET':str(target)}
        powershell=Path(os.environ['SYSTEMROOT'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
        result=subprocess.run([str(powershell),'-NoProfile','-NonInteractive','-Command',
                               'New-Item -ItemType Junction -Path $env:MAGICAST_LINK -Target $env:MAGICAST_TARGET -ErrorAction Stop | Out-Null'],env=env,capture_output=True)
        if result.returncode:self.skipTest('junction creation unavailable')
        try:
            with self.assertRaises(ProbeError):EvidenceRun(self.root,'valid','candidate',sys.executable)
            self.assertEqual((target/'keep').read_text(),'placeholder')
        finally:os.rmdir(link)  # Removes this owned junction only; never its target.
    def test_two_runs_have_no_shared_names(self):
        one=EvidenceRun(self.root,'same','candidate',sys.executable)
        two=EvidenceRun(self.root,'same','candidate',sys.executable)
        self.assertNotEqual(one.path,two.path)
        one.write('config.mjs','one');two.write('config.mjs','two')
        self.assertEqual((one.path/'config.mjs').read_text(),'one')
        self.assertEqual((two.path/'config.mjs').read_text(),'two')
    def test_mid_step_failure_and_recovery_do_not_reuse_success(self):
        first=EvidenceRun(self.root,'same','candidate',sys.executable)
        first.finish({'synthetic':'placeholder-success'})
        second=EvidenceRun(self.root,'same','candidate',sys.executable)
        try:
            second.command('failure',[sys.executable,'-c','raise SystemExit(7)'])
        except ProbeError as error:second.fail(error)
        failed=json.loads((second.path/'manifest.json').read_text())
        self.assertEqual(failed['state'],'FAILED');self.assertFalse(failed['remediation'])
        self.assertNotIn('results',failed)
        self.assertEqual(json.loads((first.path/'manifest.json').read_text())['state'],'SUCCESS')
        third=EvidenceRun(self.root,'same','candidate',sys.executable)
        self.assertEqual(third.manifest['state'],'RUNNING')
    def test_failure_while_publishing_leaves_running_manifest(self):
        run=EvidenceRun(self.root,'publication','candidate',sys.executable)
        with patch('magicast_support.os.replace',side_effect=OSError('placeholder disk failure')):
            with self.assertRaises(OSError):run.finish({'synthetic':'placeholder'})
        self.assertEqual(json.loads((run.path/'manifest.json').read_text())['state'],'RUNNING')
    def test_cannot_truncate_an_existing_artifact(self):
        run=EvidenceRun(self.root,'exclusive','candidate',sys.executable)
        run.write('keep.txt','placeholder')
        with self.assertRaises(FileExistsError):run.write('keep.txt','corrupted')
        self.assertEqual((run.path/'keep.txt').read_text(),'placeholder')
    def test_baseline_is_never_a_remediation_pass(self):
        run=EvidenceRun(self.root,'candidate','baseline',sys.executable)
        run.finish({'historical':'placeholder'})
        self.assertEqual(run.manifest['state'],'BASELINE_CHARACTERIZED')
        self.assertFalse(run.manifest['remediation'])
    def test_allowlist_discards_credentials_and_redirects_home(self):
        with patch.dict(os.environ,{'AWS_SECRET_ACCESS_KEY':'placeholder-canary','NODE_OPTIONS':'placeholder-canary',
                                    'MAGICAST_PARENT_CANARY':'placeholder-canary','PATH':'placeholder-host-path'}):
            env=minimal_environment(sys.executable,self.home)
        for key in ['AWS_SECRET_ACCESS_KEY','NODE_OPTIONS','MAGICAST_PARENT_CANARY']:
            self.assertNotIn(key,env)
        self.assertNotIn('placeholder-host-path',env['PATH'])
        self.assertEqual(env['HOME'],str(self.home))
    def test_source_export_git_does_not_inherit_credentials_or_git_overrides(self):
        import magicast_reproduce
        with patch.dict(os.environ,{'AWS_SECRET_ACCESS_KEY':'placeholder-canary','GIT_DIR':'placeholder-private-repo'}):
            with patch('magicast_reproduce.subprocess.check_output',return_value=b'placeholder') as command:
                self.assertEqual(magicast_reproduce.git(self.root,'rev-parse','HEAD'),b'placeholder')
                env=command.call_args.kwargs['env']
                self.assertNotIn('AWS_SECRET_ACCESS_KEY',env)
                self.assertNotIn('GIT_DIR',env)
                self.assertEqual(env['GIT_CONFIG_NOSYSTEM'],'1')

    def test_empty_coverage_is_rejected_even_when_optimized(self):
        clean=minimal_environment(sys.executable,self.home)
        for flags,env in [(['-O'],clean),([],dict(clean,PYTHONOPTIMIZE='1'))]:
            code="import sys;sys.path.insert(0,sys.argv[1]);import importlib.util;from pathlib import Path;s=importlib.util.spec_from_file_location('probe',Path(sys.argv[1])/'v1.5.2-magicast-probe.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p);p.validate_coverage({}, {}, Path('.'))"
            result=subprocess.run([sys.executable,*flags,'-c',code,str(HERE)],env=env,capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn(b'unexpected coverage file set',result.stderr)
    def test_missing_unused_counters_rejected(self):
        fixture=self.root/'fixture';(fixture/'src').mkdir(parents=True)
        coverage={};summary={}
        for name in probe.EXPECTED:
            file=fixture/'src'/name;file.write_text('placeholder')
            coverage[str(file)]={'path':str(file),'s':{},'f':{},'b':{},'statementMap':{},'fnMap':{},'branchMap':{}}
            summary[str(file)]={'lines':{'total':1}}
        with self.assertRaises(ProbeError):probe.validate_coverage(coverage,summary,fixture)
    def test_timeout_kills_owned_grandchild_and_leaves_unrelated_process(self):
        heartbeat=self.root/'heartbeat'
        unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],env=minimal_environment(sys.executable,self.home))
        def stop_unrelated():
            if unrelated.poll() is None: unrelated.kill()
            unrelated.wait()
        self.addCleanup(stop_unrelated)
        grandchild="import time;from pathlib import Path;p=Path("+repr(str(heartbeat))+");\nwhile True:\n p.open('a').write('x');time.sleep(.02)"
        child="import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',"+repr(grandchild)+"]);time.sleep(30)"
        with self.assertRaises(ProbeError):
            owned_process([sys.executable,'-c',child],self.root,minimal_environment(sys.executable,self.home),self.root/'timeout.log',1)
        self.assertTrue(heartbeat.exists())
        before=heartbeat.read_bytes();time.sleep(.2)
        self.assertEqual(heartbeat.read_bytes(),before)
        self.assertIsNone(unrelated.poll())
    def test_normal_exit_also_cleans_owned_grandchild(self):
        heartbeat=self.root/'normal-heartbeat'
        grandchild="import time;from pathlib import Path;p=Path("+repr(str(heartbeat))+");\nwhile True:\n p.open('a').write('x');time.sleep(.02)"
        child="import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',"+repr(grandchild)+"]);time.sleep(.3)"
        self.assertEqual(owned_process([sys.executable,'-c',child],self.root,minimal_environment(sys.executable,self.home),self.root/'normal.log',5),0)
        before=heartbeat.read_bytes();time.sleep(.2)
        self.assertEqual(heartbeat.read_bytes(),before)
    def test_original_parent_only_timeout_can_leave_a_grandchild(self):
        # Reproduce inside an outer owned job/group, so the test cannot leak it.
        heartbeat=self.root/'original-heartbeat'
        grandchild="import time;from pathlib import Path;p=Path("+repr(str(heartbeat))+");\nwhile True:\n p.open('a').write('x');time.sleep(.02)"
        child="import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',"+repr(grandchild)+"]);time.sleep(30)"
        control="import subprocess,sys,time;from pathlib import Path\ntry:subprocess.run([sys.executable,'-c',"+repr(child)+"],timeout=.6)\nexcept subprocess.TimeoutExpired:pass\np=Path("+repr(str(heartbeat))+");a=p.read_bytes();time.sleep(.2);raise SystemExit(0 if p.read_bytes()!=a else 2)"
        result=owned_process([sys.executable,'-c',control],self.root,minimal_environment(sys.executable,self.home),self.root/'original.log',5)
        self.assertIn(result,(0,2))
        if result==2:self.skipTest('parent-only orphan not reproduced under this inherited job policy')
    @unittest.skipUnless(NODE,'Node unavailable')
    def test_vm_timeout_includes_constructor_calls(self):
        code="const vm=require('vm');try{vm.runInNewContext('class Consumer {constructor(){while(true){}}};new Consumer()',{}, {timeout:100});process.exit(2)}catch(e){process.exit(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'?0:3)}"
        self.assertEqual(owned_process([NODE,'-e',code],self.root,minimal_environment(NODE,self.home),self.root/'vm.log',5),0)

    def test_incomplete_reporting_never_promotes_a_failed_run(self):
        from magicast_collect import report_terminal
        directory=self.root/'run-negative';directory.mkdir()
        manifest=directory/'manifest.json'
        manifest.write_text(json.dumps({'state':'FAILED','runId':directory.name,'steps':[]}))
        result=report_terminal(manifest)
        self.assertEqual(result['state'],'FAILED')
        self.assertFalse(result['remediation'])
        self.assertFalse(result['resultsAvailable'])
        self.assertTrue(result['notRun'])
        manifest.write_text(json.dumps({'state':'RUNNING','runId':directory.name,'steps':[]}))
        with self.assertRaises(ProbeError):report_terminal(manifest)

    def test_collector_rejects_failed_incomplete_and_tampered_runs(self):
        from magicast_collect import verify, EXPECTED_STEPS
        directory=self.root/'run-fixture';directory.mkdir()
        manifest=directory/'manifest.json'
        for value in [
            {'state':'FAILED','remediation':False},
            {'state':'SUCCESS','remediation':True,'runId':'other'},
            {'state':'SUCCESS','remediation':True,'runId':directory.name,'steps':[]},
            {'state':'SUCCESS','remediation':True,'runId':directory.name,
             'steps':[{'name':name,'exit':0} for name in EXPECTED_STEPS],
             'artifacts':{'kept.log':'0'*64}},
        ]:
            (directory/'kept.log').write_text('placeholder changed evidence')
            manifest.write_text(json.dumps(value))
            with self.assertRaises(ProbeError):verify(manifest)

class RealProbeTests(unittest.TestCase):
    @unittest.skipUnless(NODE and (ROOT/'node_modules').exists(),'installed Node tooling unavailable')
    def test_concurrent_real_runs_and_optimized_interpreters(self):
        temporary=tempfile.TemporaryDirectory(prefix='magicast-concurrency-')
        self.addCleanup(temporary.cleanup)
        env=dict(minimal_environment(NODE,Path(temporary.name)),MAGICAST_PARENT_CANARY='placeholder-parent-canary')
        children=[subprocess.Popen([sys.executable,*flags,str(HERE/'v1.5.2-magicast-probe.py'),
                                  '--node',NODE,'--label','concurrent'],cwd=ROOT,env=e,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                  for flags,e in [(['-O'],env),([],dict(env,PYTHONOPTIMIZE='1'))]]
        outputs=[]
        for child in children:
            out,err=child.communicate(timeout=90)
            self.assertEqual(child.returncode,0,err.decode(errors='replace'))
            outputs.append(json.loads(out))
        self.assertNotEqual(outputs[0]['runId'],outputs[1]['runId'])
        for output in outputs:
            m=json.loads((ROOT/output['manifest']).read_text())
            self.assertEqual(m['state'],'SUCCESS');self.assertTrue(m['remediation'])
            self.assertEqual(m['results']['artifact']['configFormsUpdated'],4)
            self.assertTrue(m['results']['artifact']['canaryPositiveControl'])
    @unittest.skipUnless(NODE and (ROOT/'node_modules').exists(),'installed Node tooling unavailable')
    def test_tampered_artifact_profile_fails_closed(self):
        with patch.dict(probe.EXPECTED_ARTIFACTS,{'index.cjs':'0'*64}):
            with self.assertRaises(ProbeError):probe.run_probe(ROOT,NODE,'release','candidate')
    @unittest.skipUnless(NODE and (ROOT/'node_modules').exists(),'installed Node tooling unavailable')
    def test_baseline_mode_does_not_characterize_candidate_as_baseline(self):
        with self.assertRaises(ProbeError):probe.run_probe(ROOT,NODE,'candidate','baseline')

if __name__=='__main__':
    unittest.main()
