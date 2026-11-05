"""Reproducible Magicast QA; source-only fixtures and isolated evidence.
Default candidate mode verifies the reviewed artifacts and effective external map
implementation. Baseline is historical characterization, never remediation PASS.
Filesystem access is that of the caller; the runner is not an OS sandbox.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys

from magicast_fixtures import FILES, EXPECTED_ARTIFACTS, PROBE
from magicast_evidence import tool_inputs
from magicast_support import EvidenceRun, ProbeError, require, safe_directory, validate_label

METRICS = ('statements', 'functions', 'branches', 'lines')
EXPECTED = {
    'dependency.ts': (1, 1, 0, 1),
    'legacy.cjs': (2, 1, 0, 1),
    'math.ts': (4, 2, 2, 3),
    'unused.ts': (1, 1, 2, 1),
}

def validate_coverage(coverage, summary, fixture):
    require(isinstance(coverage, dict) and len(coverage) == len(EXPECTED), 'unexpected coverage file set')
    normalized = {}
    for key, value in coverage.items():
        file = Path(key).resolve(strict=True)
        require(file.parent == (fixture/'src').resolve(strict=True), 'coverage path outside fixture src')
        name = file.name
        require(name in EXPECTED and name not in normalized, 'duplicate or unexpected coverage file')
        require(Path(value['path']).resolve(strict=True) == file, 'coverage key/path mismatch')
        for map_key, count_key in [('statementMap','s'), ('fnMap','f'), ('branchMap','b')]:
            require(isinstance(value[map_key],dict) and isinstance(value[count_key],dict), 'invalid counter maps')
            require(value[map_key].keys()==value[count_key].keys(), 'map/counter mismatch')
            for ident, count in value[count_key].items():
                counts = count if count_key=='b' else [count]
                require(isinstance(counts,list) and len(counts)>0, 'empty counter vector')
                require(all(type(x) is int and x>=0 for x in counts), 'invalid counter value')
                if count_key=='b':
                    require(len(counts)==len(value['branchMap'][ident]['locations']), 'branch counter length mismatch')
        totals=(len(value['s']),len(value['f']),sum(map(len,value['b'].values())),summary[key]['lines']['total'])
        require(totals==EXPECTED[name], 'missing or changed fixture denominators: '+name)
        per_file=summary[key]
        for metric,total in zip(METRICS,EXPECTED[name]):
            data=per_file[metric]
            require(type(data['total']) is int and data['total']==total, 'per-file denominator mismatch')
            require(type(data['covered']) is int and 0<=data['covered']<=total, 'invalid coverage numerator')
            require(isinstance(data['pct'],(int,float)) and math.isfinite(data['pct']), 'invalid percentage')
        if name in ('unused.ts','dependency.ts'):
            require(all(x==0 for x in value['s'].values()), 'unimported statement executed')
            require(all(x==0 for x in value['f'].values()), 'unimported function executed')
            require(all(x==0 for v in value['b'].values() for x in v), 'unimported branch executed')
            require(all(per_file[m]['covered']==0 for m in METRICS), 'unimported file has nonzero metrics')
        if name=='math.ts':
            choose=[(ident,v) for ident,v in value['fnMap'].items() if v['name']=='choose']
            require(len(choose)==1 and choose[0][1]['decl']['start']['line']==4, 'original TypeScript position lost')
            require(value['f'][choose[0][0]]==2, 'function invocation count changed')
            require(sorted(value['s'].values())==[0,0,2,2], 'statement counts changed')
            require(list(value['b'].values())==[[2,0]], 'branch counts changed')
        normalized[name]={**value,'path':'src/'+name,'summary':per_file}
    require(normalized.keys()==EXPECTED.keys(), 'missing fixture file')
    for metric in METRICS:
        require(summary['total'][metric]['total']==sum(x['summary'][metric]['total'] for x in normalized.values()), 'global denominator differs from files')
        require(summary['total'][metric]['covered']==sum(x['summary'][metric]['covered'] for x in normalized.values()), 'global numerator differs from files')
    return normalized

def run_probe(root, node, label, mode='candidate'):
    validate_label(label)  # No disk writes until mode, label, root and binary are checked.
    require(mode in ('candidate','baseline'), 'invalid mode')
    root=Path(root).resolve(strict=True)
    require((root/'package.json').is_file() and (root/'node_modules/vitest/vitest.mjs').is_file(), 'run from an installed source checkout')
    binary=Path(node).resolve(strict=True)
    require(binary.is_file(), 'Node executable is not a file')
    run=EvidenceRun(root,label,mode,binary)
    try:
        fixture=safe_directory(run.path,['fixture'])
        safe_directory(fixture,['src'])
        for name,content in FILES.items():
            with (fixture/name).open('x',encoding='utf-8') as stream:
                stream.write(content)
        (fixture/'.env').write_text('VITE_MAGICAST_DISK_CANARY=placeholder-disk-canary\n',encoding='utf-8')
        (fixture/'env.test.ts').write_text('''import {expect,it} from 'vitest';
it('does not load synthetic dotenv or inherit parent canaries',()=>{
 expect(import.meta.env.VITE_MAGICAST_DISK_CANARY).toBeUndefined();
 expect(process.env.MAGICAST_PARENT_CANARY).toBeUndefined();
 expect(process.env.NODE_OPTIONS).toBeUndefined();
});\n''',encoding='utf-8')
        run.write('expected-artifacts.json',json.dumps(EXPECTED_ARTIFACTS))
        run.write('probe.mjs',PROBE)
        run.manifest['inputs']={'lockSha256':hashlib.sha256((root/'package-lock.json').read_bytes()).hexdigest(),
                                'tools':tool_inputs(root)}
        run.publish()
        run.command('artifact',[str(binary),str(run.path/'probe.mjs'),str(run.path/'artifact.json'),mode,str(root)])
        artifact=json.loads((run.path/'artifact.json').read_text(encoding='utf-8'))
        require(artifact['mode']==mode and artifact['remediation']==(mode=='candidate'), 'artifact mode mismatch')
        results=[]
        for pool,form in [('forks','defineConfig'),('threads','mergeConfig')]:
            report=safe_directory(run.path,['coverage-'+pool])
            config={'root':fixture.as_posix(),'envDir':False,'test':{'include':['*.test.ts'],'exclude':[],
                    'pool':pool,'maxWorkers':2,'coverage':{'enabled':True,'provider':'v8','include':['src/**'],
                    'reporter':['json','json-summary'],'reportsDirectory':report.as_posix(),
                    'thresholds':{'autoUpdate':True,**dict.fromkeys(METRICS,0)}}}}
            body='defineConfig('+json.dumps(config)+')'
            if form=='mergeConfig':body='mergeConfig({}, '+body+')'
            config_path=run.path/('config-'+pool+'.mjs')
            run.write(config_path.name,"import {defineConfig,mergeConfig} from 'vitest/config';\nexport default "+body+';\n')
            run.verify()
            run.command('coverage-'+pool,[str(binary),str(root/'node_modules/vitest/vitest.mjs'),'run','--config',str(config_path)])
            coverage=json.loads((report/'coverage-final.json').read_text(encoding='utf-8'))
            summary=json.loads((report/'coverage-summary.json').read_text(encoding='utf-8'))
            normalized=validate_coverage(coverage,summary,fixture)
            updated=config_path.read_text(encoding='utf-8')
            require('__VITEST_COVERAGE_MARKER__' not in updated,'internal marker persisted')
            reader='read-'+pool+'.mjs'
            run.write(reader,"import fs from 'node:fs'; import config from './"+config_path.name+"'; fs.writeFileSync(process.argv[2],JSON.stringify(config.test.coverage.thresholds),{flag:'wx'});\n")
            thresholds_file=run.path/('thresholds-'+pool+'.json')
            run.command('thresholds-'+pool,[str(binary),str(run.path/reader),str(thresholds_file)])
            thresholds=json.loads(thresholds_file.read_text(encoding='utf-8'))
            for metric in METRICS:
                require(thresholds[metric]==summary['total'][metric]['pct'] and thresholds[metric]>0,'autoUpdate did not set real metrics')
            results.append({'pool':pool,'form':form,'summary':summary['total'],'thresholds':thresholds,'files':normalized})
        run.finish({'artifact':artifact,'coverage':results})
    except BaseException as error:
        try:
            run.fail(error)
        except (OSError, ProbeError):
            pass  # A retained RUNNING manifest is incomplete, never a success.
        raise
    return run

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--label',required=True)
    parser.add_argument('--mode',choices=['candidate','baseline'],default='candidate')
    args=parser.parse_args(argv)
    try:
        require(bool(args.node),'Node executable not found')
        # An injected parent canary is synthetic and deliberately filtered out.
        os.environ['MAGICAST_PARENT_CANARY']='placeholder-parent-canary'
        run=run_probe(Path.cwd(),args.node,args.label,args.mode)
        print(json.dumps({'runId':run.id,'mode':args.mode,'state':run.manifest['state'],
                          'remediation':run.manifest['remediation'],'manifest':str((run.path/'manifest.json').relative_to(run.root))}))
        return 0
    except (ProbeError,OSError,ValueError,KeyError,StopIteration) as error:
        print('Magicast QA failed: '+type(error).__name__,file=sys.stderr)
        return 1

if __name__=='__main__':
    sys.exit(main())
