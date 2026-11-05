"""Repeat Story 2 QA from neutral, source-only exports, without private config.
Uses git archive of the approved public base, overlays only reviewed candidate
paths, and initializes a disposable indexed repository for safety checks.
No worktree/ref/commit is created in the source repository. Exports are retained.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import sys
import tarfile

from magicast_evidence import prepare_export, source_inputs, tool_inputs
from magicast_support import EvidenceRun, ProbeError, require, safe_directory, minimal_environment

BASE='ae7797e41931778940d87f3a5c58b13c6df31c89'
DEADLINE_PATCH=('scripts/qa-identity-conflict-review.ts','tests/qa-identity-conflict-review.test.ts')
GATES=['typecheck','lint','build','test','test:integration','test:acceptance','test:system','test:security','security:repo','coverage']

def git(root,*args):
    binary=shutil.which('git')
    require(bool(binary),'Git executable unavailable')
    home=Path(tempfile.mkdtemp(prefix='magicast-git-'))
    env=minimal_environment(sys.executable,home)
    env['GIT_CONFIG_NOSYSTEM']='1'
    try:
        return subprocess.check_output([binary,'-c','safe.directory='+root.as_posix(),'-C',str(root),*args],env=env)
    finally:
        try:home.rmdir()  # Empty owned directory only; never recursive cleanup.
        except OSError:pass

def snapshot(root,run,kind,deadline_reference_patch=False):
    destination=safe_directory(run.path,[kind+'-source'])
    data=git(root,'archive','--format=tar',BASE)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            parts=Path(member.name).parts
            require(not Path(member.name).is_absolute() and '..' not in parts,'invalid public archive path')
            require(member.isdir() or member.isfile(),'public archive contains non-regular files')
            target=destination/member.name
            if member.isdir():target.mkdir(parents=True,exist_ok=True)
            else:
                target.parent.mkdir(parents=True,exist_ok=True)
                with target.open('xb') as output:output.write(archive.extractfile(member).read())
    tools=[root/name for name in tool_inputs(root)]
    overlay=[p.relative_to(root) for p in tools]
    if kind=='baseline' and deadline_reference_patch:
        overlay.extend(Path(p) for p in DEADLINE_PATCH)
    if kind=='candidate':
        changes=git(root,'diff','--name-only',BASE).decode().splitlines()
        new=git(root,'ls-files','--others','--exclude-standard','-z').decode().split('\0')
        overlay.extend(Path(p) for p in changes+new if p)
    for relative in sorted(set(overlay)):
        require(relative.as_posix() in {'package.json','package-lock.json','docs/dependency-security-review.md','.github/workflows/ci.yml'}
                or relative.as_posix().startswith('docs/qa/') or relative.as_posix() in DEADLINE_PATCH,'candidate contains an out-of-scope change')
        source=root/relative
        require(source.is_file() and not source.is_symlink(),'overlay must be a regular public file')
        target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(source.read_bytes())
    require(not (destination/'.env').exists() and not (destination/'.private-runtime').exists(),'neutral export contains private config')
    run.command(kind+'-git-init',['git','init','--quiet',str(destination)])
    prepare_export(destination)
    return destination

def read_probe(source,log):
    text=log.read_text(encoding='utf-8',errors='strict')
    lines=[line for line in text.splitlines() if line.startswith('{')]
    require(len(lines)==1,'probe must report exactly one run')
    result=json.loads(lines[0])
    from magicast_evidence import checked_file
    path=checked_file(source,Path(result['manifest']).as_posix())
    manifest=json.loads(path.read_text(encoding='utf-8'))
    require(manifest['runId']==result['runId'] and manifest['state']==result['state'],'manifest identity mismatch')
    for name,digest in manifest['artifacts'].items():
        from magicast_evidence import checked_file
        require(hashlib.sha256(checked_file(path.parent,name).read_bytes()).hexdigest()==digest,'artifact provenance mismatch')
    require(len(manifest['steps'])==5 and all(s['exit']==0 for s in manifest['steps']),'incomplete probe')
    return manifest

def normalized_coverage(source,report):
    result={}
    for filename,value in json.loads((report/'coverage-final.json').read_text(encoding='utf-8')).items():
        relative=Path(filename).relative_to(source).as_posix()
        result[relative]={**value,'path':relative}
    return result

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',required=True)
    parser.add_argument('--npm-cli',required=True)
    parser.add_argument('--label',required=True)
    parser.add_argument('--deadline-reference-patch',action='store_true',help='compare against H1 plus the common deadline fix; this is not the unmodified historical SHA')
    args=parser.parse_args(argv)
    root=Path.cwd().resolve();node=Path(args.node).resolve(strict=True);npm=Path(args.npm_cli).resolve(strict=True)
    require(git(root,'rev-parse','HEAD').decode().strip()==BASE,'HEAD differs from audited base')
    run=EvidenceRun(root,args.label,'candidate',node)
    try:
        run.write('npm-user.conf','')
        run.write('npm-global.conf','')
        run.env['NPM_CONFIG_USERCONFIG']=str(run.path/'npm-user.conf')
        run.env['NPM_CONFIG_GLOBALCONFIG']=str(run.path/'npm-global.conf')
        reference={'originSha':BASE,'kind':'corrected-reference' if args.deadline_reference_patch else 'historical-exact',
                   'patchSha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in DEADLINE_PATCH} if args.deadline_reference_patch else {}}
        run.manifest['reference']=reference
        run.publish()
        baseline=snapshot(root,run,'baseline',args.deadline_reference_patch);candidate=snapshot(root,run,'candidate')
        inputs={kind:source_inputs(source) for kind,source in [('baseline',baseline),('candidate',candidate)]}
        run.write('provenance.json',json.dumps({'exports':inputs,'reference':reference},sort_keys=True))
        lock_hash=hashlib.sha256((candidate/'package-lock.json').read_bytes()).hexdigest()
        for kind,source in [('baseline',baseline),('candidate',candidate)]:
            run.command(kind+'-ci',[str(node),str(npm),'ci'],cwd=source,timeout=180)
            require(hashlib.sha256((candidate/'package-lock.json').read_bytes()).hexdigest()==lock_hash,'candidate lock changed')
            if kind=='candidate':
                run.command('candidate-second-ci',[str(node),str(npm),'ci'],cwd=source,timeout=180)
                require(hashlib.sha256((source/'package-lock.json').read_bytes()).hexdigest()==lock_hash,'second ci changed lock')
                run.command('runner-negative-tests',[sys.executable,'-m','unittest','discover','-s','docs/qa','-p','test_*.py','-v'],cwd=source)
            run.command(kind+'-probe',[sys.executable,str(source/'docs/qa/v1.5.2-magicast-probe.py'),
                                      '--node',str(node),'--label','release','--mode',kind],cwd=source)
            if kind=='baseline':
                # A vulnerable historical installation cannot pass default mode,
                # regardless of a harmless label that used to bypass the guard.
                check="import subprocess,sys;r=subprocess.run(sys.argv[1:]);raise SystemExit(0 if r.returncode==1 else 2)"
                for label in ['release','baseline','candidate']:
                    run.command('reject-vulnerable-'+label,[sys.executable,'-c',check,sys.executable,
                                str(source/'docs/qa/v1.5.2-magicast-probe.py'),'--node',str(node),'--label',label],cwd=source)
            for gate in (['coverage'] if kind=='baseline' else GATES):
                name=kind+'-'+gate.replace(':','-')
                command=[str(node),str(npm),'run',gate]
                if gate.startswith('test') or gate=='coverage':
                    command+=['--','--maxWorkers=4']
                if gate=='coverage':
                    directory=safe_directory(run.path,[kind+'-coverage'])
                    command+=['--coverage.reporter=text-summary','--coverage.reporter=json','--coverage.reporter=json-summary','--coverage.reportsDirectory',str(directory)]
                run.command(name,command,cwd=source,timeout=240)
        for name,command in [('tree',['ls','--all','--json']),('audit',['audit','--json']),('audit-production',['audit','--omit=dev','--json'])]:
            run.command('candidate-'+name,[str(node),str(npm),*command],cwd=candidate,timeout=120)
        bp=read_probe(baseline,run.path/'baseline-probe.log');cp=read_probe(candidate,run.path/'candidate-probe.log')
        require(bp['state']=='BASELINE_CHARACTERIZED' and not bp['remediation'],'baseline incorrectly reports remediation')
        require(cp['state']=='SUCCESS' and cp['remediation'],'candidate is not verified')
        require(bp['results']['coverage']==cp['results']['coverage'],'synthetic maps/counters differ')
        before=normalized_coverage(baseline,run.path/'baseline-coverage')
        after=normalized_coverage(candidate,run.path/'candidate-coverage')
        require(before and before.keys()==after.keys(),'coverage file set changed or empty')
        differences=[]
        for filename,b in before.items():
            a=after[filename]
            for field in ['statementMap','fnMap','branchMap']:
                require(b[field]==a[field],'coverage maps changed: '+filename)
            counters={field:{k:{'before':v,'after':a[field][k]} for k,v in b[field].items() if v!=a[field][k]} for field in ['s','f','b']}
            if any(counters.values()):differences.append({'file':filename,'counterChanges':counters})
        base_lock=json.loads((baseline/'package-lock.json').read_text());candidate_lock=json.loads((candidate/'package-lock.json').read_text())
        production=lambda lock:{k:v for k,v in lock['packages'].items() if k and not v.get('dev')}
        require(production(base_lock)==production(candidate_lock),'production dependencies changed')
        results={'node':cp['results']['artifact']['node'],'base':BASE,'lockSha256':lock_hash,
                 'baselineSummary':json.loads((run.path/'baseline-coverage/coverage-summary.json').read_text())['total'],
                 'candidateSummary':json.loads((run.path/'candidate-coverage/coverage-summary.json').read_text())['total'],
                 'coverageFiles':len(before),'mapsIdentical':True,'syntheticMapsAndCountersIdentical':True,
                 'counterDifferences':differences,'productionEntries':len(production(candidate_lock)),
                 'baselineProbe':{'runId':bp['runId'],'state':bp['state']},
                 'candidateProbe':{'runId':cp['runId'],'state':cp['state']},
                 'artifact':cp['results']['artifact'],'toolHashes':cp['inputs']['tools'],'reference':reference,'exports':inputs}
        require(source_inputs(baseline)==inputs['baseline'] and source_inputs(candidate)==inputs['candidate'],'source changed during QA')
        run.finish(results)
        print(json.dumps({'runId':run.id,'state':run.manifest['state'],'manifest':str((run.path/'manifest.json').relative_to(root))}))
        return 0
    except BaseException as error:
        try:run.fail(error)
        except (OSError,ProbeError):pass
        print(json.dumps({'runId':run.id,'state':'FAILED','error':type(error).__name__}),file=sys.stderr)
        return 1

if __name__=='__main__':
    sys.exit(main())
