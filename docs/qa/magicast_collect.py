"""Collect only complete, hash-verified, exclusive reproduction manifests.
Raw local logs, sources and paths stay ignored. The public summary carries
provenance digests and measured gate outcomes; it never manufactures PASS.
"""
import argparse
import hashlib
import json
from pathlib import Path

from magicast_support import atomic_json, require

EXPECTED_STEPS={'baseline-git-init','candidate-git-init','baseline-ci','baseline-probe',
                'reject-vulnerable-release','reject-vulnerable-baseline','reject-vulnerable-candidate',
                'baseline-coverage','candidate-ci','candidate-second-ci','runner-negative-tests','candidate-probe',
                'candidate-typecheck','candidate-lint','candidate-build','candidate-test',
                'candidate-test-integration','candidate-test-acceptance','candidate-test-system',
                'candidate-test-security','candidate-security-repo','candidate-coverage',
                'candidate-tree','candidate-audit','candidate-audit-production'}

def verify(path, current_root=None):
    from magicast_evidence import checked_file
    original=Path(path).absolute()
    path=checked_file(original.parent,original.name).resolve(strict=True)
    manifest=json.loads(path.read_text(encoding='utf-8'))
    require(manifest.get('state')=='SUCCESS' and manifest.get('remediation') is True,'run is incomplete or failed')
    require(manifest.get('runId')==path.parent.name,'run identity mismatch')
    steps=manifest['steps']
    require({s['name'] for s in steps}==EXPECTED_STEPS and len(steps)==len(EXPECTED_STEPS),'missing or duplicate gates')
    require(all(s['exit']==0 for s in steps),'failed gate')
    require(isinstance(manifest.get('results'),dict) and isinstance(manifest.get('artifacts'),dict),'missing evidence contract')
    from magicast_evidence import verify_evidence
    verify_evidence(path,manifest,Path(current_root or Path.cwd()).resolve(strict=True))
    results=manifest['results']
    return {'runId':manifest['runId'],'manifestSha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'runtime':results['node'],'base':results['base'],'lockSha256':results['lockSha256'],
            'gates':steps,'baselineSummary':results['baselineSummary'],'candidateSummary':results['candidateSummary'],
            'coverageFiles':results['coverageFiles'],'mapsIdentical':results['mapsIdentical'],
            'syntheticMapsAndCountersIdentical':results['syntheticMapsAndCountersIdentical'],
            'counterDifferences':results['counterDifferences'],'productionEntries':results['productionEntries'],
            'artifact':results['artifact'],'toolHashes':results['toolHashes'],
            'reference':results['reference'],'exports':results['exports']}

def report_terminal(path):
    """Report a failure as a failure; never accept it as complete verification."""
    from magicast_evidence import checked_file
    original=Path(path).absolute()
    path=checked_file(original.parent,original.name).resolve(strict=True)
    manifest=json.loads(path.read_text(encoding='utf-8'))
    require(manifest.get('state') in ('SUCCESS','FAILED') and manifest.get('runId')==path.parent.name,'not a terminal owned run')
    if manifest['state']=='SUCCESS':
        try:return {**verify(path),'state':'SUCCESS'}
        except (ValueError,KeyError,OSError,RuntimeError):pass
    steps=manifest['steps']
    names=[step['name'] for step in steps]
    require(len(names)==len(set(names)) and set(names)<=EXPECTED_STEPS,'invalid partial gates')
    results=manifest.get('results',{})
    from magicast_reproduce import read_probe
    baseline_log=path.parent/'baseline-probe.log'
    baseline=read_probe(path.parent/'baseline-source',baseline_log) if baseline_log.exists() else None
    logs={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in path.parent.glob('*.log') if p.is_file() and not p.is_symlink()}
    return {'runId':manifest['runId'],'state':'FAILED' if manifest['state']=='FAILED' else 'HISTORICAL_INCOMPLETE','remediation':False,
            'manifestSha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'runtime':results.get('node') or (baseline['results']['artifact']['node'] if baseline else None),
            'gates':steps,'notRun':sorted(EXPECTED_STEPS-set(names)),'logSha256':logs,
            'toolHashes':results.get('toolHashes',baseline['inputs']['tools'] if baseline else {}),
            'resultsAvailable':False,'reference':manifest.get('reference',results.get('reference'))}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='append',required=True)
    parser.add_argument('--report-incomplete',action='store_true',help='write a NO_GO report including terminal failures; exit nonzero')
    args=parser.parse_args()
    runs=[report_terminal(p) if args.report_incomplete else verify(p) for p in args.run]
    require(len(runs)==2 and {r['runtime'] for r in runs}=={'v20.19.0','v22.23.2'},'exact runtimes required')
    root=Path.cwd()
    digest=hashlib.sha256((root/'package-lock.json').read_bytes()).hexdigest()
    require(all(r.get('lockSha256',digest)==digest for r in runs),'evidence does not match current lock')
    from magicast_evidence import tool_inputs, comparable
    tools=tool_inputs(root)
    for result in runs:result['currentToolsMatchProducer']=result['toolHashes']==tools
    if not args.report_incomplete:
        comparable(runs)
        require(all(r['currentToolsMatchProducer'] for r in runs),'evidence does not match current QA tools')
    inventory={'schema':2,'state':'NO_GO' if args.report_incomplete else 'VERIFIED_LOCAL','base':'ae7797e41931778940d87f3a5c58b13c6df31c89',
               'scope':'Windows local source-only reproduction; no hosted CI certification',
               'runs':runs,'linux':'NOT RUN','hostedCI':'NOT RUN',
               'historicalInventory':'Previous schema-1 results are superseded, not silently reused.'}
    atomic_json(root/'docs/qa/v1.5.2-magicast-inventory.json',inventory)
    print('Collected NO_GO report; incomplete evidence was not promoted.' if args.report_incomplete else 'Collected two complete, provenance-verified runs.')
    return 1 if args.report_incomplete else 0

if __name__=='__main__':
    raise SystemExit(main())
