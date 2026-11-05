"""Evidence contract: public inputs, owned paths and required measured artifacts.
Hashes detect stale or incomplete evidence, not a user rewriting all evidence.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat

from magicast_support import require, plain_directory

COVERAGE_FILES={kind+'-coverage/'+name for kind in ('baseline','candidate')
                for name in ('coverage-final.json','coverage-summary.json')}
PROBE_STEPS={'artifact','coverage-forks','coverage-threads','thresholds-forks','thresholds-threads'}
PROBE_FILES={name+'.log' for name in PROBE_STEPS}|{
    'artifact.json','expected-artifacts.json','probe.mjs',
    'config-forks.mjs','config-threads.mjs','read-forks.mjs','read-threads.mjs',
    'thresholds-forks.json','thresholds-threads.json'}|{
    'coverage-'+pool+'/'+name for pool in ('forks','threads')
    for name in ('coverage-final.json','coverage-summary.json')}


def checked_file(root,name):
    require(isinstance(name,str) and '\\' not in name,'unsafe evidence path')
    parts=PurePosixPath(name).parts
    require(parts and not PurePosixPath(name).is_absolute() and ':' not in name
            and all(p not in ('.','..') for p in parts)
            and '/'.join(parts)==name,'unsafe evidence path')
    for parent in reversed(root.parents):plain_directory(parent)
    plain_directory(root)
    current=root
    for part in parts[:-1]:
        current=current/part
        plain_directory(current)
    file=current/parts[-1]
    info=file.lstat()
    require(stat.S_ISREG(info.st_mode) and not getattr(info,'st_file_attributes',0)&0x400,
            'evidence must be a regular file')
    require(file.resolve(strict=True).is_relative_to(root.resolve(strict=True)),'evidence escapes run')
    return file


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def relevant(name):
    return not name.endswith('.md') and (not name.startswith('docs/') or name.startswith('docs/qa/') and name.endswith('.py'))


def source_inputs(root):
    from magicast_reproduce import git
    names=set(git(root,'ls-files','-z').decode().split('\0'))|set(git(root,'ls-files','--others','--exclude-standard','-z').decode().split('\0'))
    return {name:sha(checked_file(root,name)) for name in sorted(names) if name and relevant(name)}


def tool_inputs(root):
    return {p.relative_to(root).as_posix():sha(checked_file(root,p.relative_to(root).as_posix()))
            for p in sorted((root/'docs/qa').glob('*.py'))}


def prepare_export(destination):
    """Only freshly extracted, public, dependency-free exports may call this.
    Rebuild their disposable index before npm creates ignored generated files.
    """
    from magicast_reproduce import git
    names=[]
    for file in destination.rglob('*'):
        relative=file.relative_to(destination)
        if relative.parts[0]=='.git':continue
        if file.is_dir():plain_directory(file)
        else:
            checked_file(destination,relative.as_posix())
            names.append(relative.as_posix())
    require(not (destination/'node_modules').exists(),'export already has dependencies')
    git(destination,'add','--force','--all')
    indexed=set(git(destination,'ls-files','-z').decode().split('\0'))-{''}
    require(indexed==set(names),'export index omits snapshot files')
    return sorted(indexed)


def artifacts(root,declared,required):
    require(isinstance(declared,dict) and required<=declared.keys(),'missing mandatory evidence artifacts')
    for name,digest in declared.items():
        require(isinstance(digest,str) and len(digest)==64 and sha(checked_file(root,name))==digest,
                'artifact changed after run')


def reference_identity(reference,inputs):
    from magicast_reproduce import BASE,DEADLINE_PATCH
    require(isinstance(reference,dict) and reference.get('originSha')==BASE,'incompatible reference origin')
    kind=reference.get('kind');patch=reference.get('patchSha256')
    require(kind in ('historical-exact','corrected-reference'),'unknown reference kind')
    expected={name:inputs[name] for name in DEADLINE_PATCH} if kind=='corrected-reference' else {}
    require(patch==expected,'reference patch differs from candidate')


def verify_evidence(path,manifest,current_root):
    from magicast_reproduce import BASE,DEADLINE_PATCH,read_probe,normalized_coverage,git
    root=path.parent;results=manifest['results']
    required={step['name']+'.log' for step in manifest['steps']}|COVERAGE_FILES|{'npm-user.conf','npm-global.conf','provenance.json'}
    artifacts(root,manifest['artifacts'],required)
    provenance=json.loads(checked_file(root,'provenance.json').read_text(encoding='utf-8'))
    inputs=provenance['exports']
    require(set(inputs)=={'baseline','candidate'},'missing export identities')
    require(inputs==results.get('exports'),'export provenance mismatch')
    require(source_inputs(current_root)==inputs['candidate'],'evidence does not match current candidate')
    require(results['base']==BASE,'incompatible base')
    reference=results.get('reference')
    require(reference==manifest.get('reference')==provenance.get('reference'),'inconsistent reference identities')
    reference_identity(reference,inputs['candidate'])
    # Reconstruct the approved reference identity without trusting its declaration.
    import io,tarfile
    historical={}
    with tarfile.open(fileobj=io.BytesIO(git(current_root,'archive','--format=tar',BASE))) as archive:
        for member in archive.getmembers():
            if member.isfile() and relevant(member.name):
                historical[member.name]=hashlib.sha256(archive.extractfile(member).read()).hexdigest()
    historical.update(tool_inputs(current_root))
    if reference['kind']=='corrected-reference':
        historical.update({name:inputs['candidate'][name] for name in DEADLINE_PATCH})
    require(inputs['baseline']==historical,'baseline is not the declared approved reference')
    probes={}
    for kind in ('baseline','candidate'):
        source=root/(kind+'-source')
        require(source_inputs(source)==inputs[kind],'export changed after QA')
        require(sha(checked_file(source,'package-lock.json'))==
                (results['lockSha256'] if kind=='candidate' else inputs[kind]['package-lock.json']),'lock provenance mismatch')
        probe=read_probe(source,checked_file(root,kind+'-probe.log'))
        line=json.loads(next(x for x in (root/(kind+'-probe.log')).read_text(encoding='utf-8').splitlines() if x.startswith('{')))
        probe_path=checked_file(source,Path(line['manifest']).as_posix())
        artifacts(probe_path.parent,probe['artifacts'],PROBE_FILES)
        require({s['name'] for s in probe['steps']}==PROBE_STEPS and len(probe['steps'])==len(PROBE_STEPS),'probe gates mismatch')
        require(probe['inputs']['tools']==tool_inputs(current_root)==results['toolHashes'],'QA tools changed')
        require(probe['inputs']['lockSha256']==inputs[kind]['package-lock.json'],'probe lock provenance mismatch')
        require(probe['results']['artifact']['node']==results['node'],'runtime provenance mismatch')
        expected_state='SUCCESS' if kind=='candidate' else 'BASELINE_CHARACTERIZED'
        require(probe['state']==expected_state and probe['remediation']==(kind=='candidate'),'invalid probe state')
        require(results[kind+'Probe']=={'runId':probe['runId'],'state':probe['state']},'probe identity mismatch')
        require(json.loads(checked_file(root,kind+'-coverage/coverage-summary.json').read_text(encoding='utf-8'))['total']==results[kind+'Summary'],'coverage summary provenance mismatch')
        probes[kind]=probe
    require(probes['baseline']['results']['coverage']==probes['candidate']['results']['coverage'] and results['syntheticMapsAndCountersIdentical'] is True,'synthetic coverage mismatch')
    require(results['artifact']==probes['candidate']['results']['artifact'],'artifact result provenance mismatch')
    before=normalized_coverage(root/'baseline-source',root/'baseline-coverage')
    after=normalized_coverage(root/'candidate-source',root/'candidate-coverage')
    require(before and before.keys()==after.keys() and len(before)==results['coverageFiles'],'coverage file set mismatch')
    differences=[]
    for filename,b in before.items():
        a=after[filename]
        require(all(b[field]==a[field] for field in ('statementMap','fnMap','branchMap')),'coverage maps differ')
        require(sha(checked_file(root/'baseline-source',filename))==sha(checked_file(root/'candidate-source',filename)),'instrumented sources differ')
        counters={field:{k:{'before':v,'after':a[field][k]} for k,v in b[field].items() if v!=a[field][k]} for field in ('s','f','b')}
        if any(counters.values()):differences.append({'file':filename,'counterChanges':counters})
    require(results['mapsIdentical'] is True and results['counterDifferences']==differences,'coverage comparison provenance mismatch')
    locks=[json.loads(checked_file(root/(kind+'-source'),'package-lock.json').read_text(encoding='utf-8')) for kind in ('baseline','candidate')]
    production=lambda lock:{k:v for k,v in lock['packages'].items() if k and not v.get('dev')}
    require(production(locks[0])==production(locks[1]) and len(production(locks[1]))==results['productionEntries'],'production dependency mismatch')


def comparable(runs):
    require(len(runs)==2 and {r['runtime'] for r in runs}=={'v20.19.0','v22.23.2'},'exact runtimes required')
    require(runs[0]['reference']==runs[1]['reference'],'incompatible references between runtimes')
    require(runs[0]['exports']==runs[1]['exports'],'incompatible export identities between runtimes')
