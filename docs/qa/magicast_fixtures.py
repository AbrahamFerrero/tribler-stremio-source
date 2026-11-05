"""Owned synthetic fixtures, under the repository license."""

FILES = {
    'src/math.ts': """type Sample = {
  value: number;
};
export function choose(sample: Sample): number {
  if (sample.value > 0) return sample.value * 2;
  return -1;
}
export function unusedFunction(): number { return 99; }
""",
    'src/dependency.ts': """export function seed(): number { return 3; }
""",
    'src/unused.ts': """export function neverImported(value: number): number { return value ? 1 : 0; }
""",
    'src/legacy.cjs': """module.exports = function legacy(value) { return value + 1; };
""",
    'math.test.ts': """import { expect, it } from 'vitest';
import { choose } from './src/math';
import legacy from './src/legacy.cjs';
it('remaps transformed TypeScript and executes CommonJS', () => {
  expect(choose({ value: 2 })).toBe(4);
  expect(legacy(2)).toBe(3);
});
""",
    'mock.test.ts': """import { expect, it, vi } from 'vitest';
import { seed } from './src/dependency';
import { choose } from './src/math';
vi.mock('./src/dependency', () => ({ seed: () => 4 }));
it('hoists a module mock in an isolated worker', () => {
  expect(seed()).toBe(4);
  expect(choose({ value: seed() })).toBe(8);
});
""",
}

EXPECTED_ARTIFACTS = {
    "helpers.cjs": "8ff1817b915bb37a1d091af76a8f98c6b7ff86775581054b47aaf2665f79ef03",
    "helpers.mjs": "39654aeac8ff3227d20da7936b303a322e3717de88a84c723c30090ac89b47ca",
    "index.cjs": "26b38ba26f111b3dd3c8ed8b74b4ea2389d47b945cf05100d3ce152e8f2fbec6",
    "index.mjs": "2fe6dddb7909c68a4c514655c0064ccec3657028703bf81da72c594bbc10bef4"
}

PROBE = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse} from '@babel/parser';
import {loadEnv} from 'vite';
const [output,mode,root] = process.argv.slice(2);
assert.ok(['candidate','baseline'].includes(mode));
const work=path.dirname(output);
const require=createRequire(path.join(root,'package.json'));
const providerRequire=createRequire(require.resolve('@vitest/coverage-v8'));
const entry=providerRequire.resolve('magicast');
const magicastRequire=createRequire(entry);
const manifest=magicastRequire('../package.json');
const dir=path.dirname(entry);
const artifacts=fs.readdirSync(dir,{recursive:true}).filter(x=>/\.(cjs|mjs|js)$/.test(x)).sort().map(file=>{
 const code=fs.readFileSync(path.join(dir,file),'utf8');
 return {file,code,sha256:createHash('sha256').update(code).digest('hex')};
});
const expected=JSON.parse(fs.readFileSync(path.join(work,'expected-artifacts.json'),'utf8'));
if(mode==='candidate') {
 assert.equal(manifest.version,'0.3.5');
 assert.deepEqual(Object.fromEntries(artifacts.map(x=>[x.file,x.sha256])),expected,'Unreviewed executable artifact');
} else assert.equal(manifest.version,'0.5.5','Baseline must characterize the exact historical version');
function importsSourceMap(code) {
 const tree=parse(code,{sourceType:'unambiguous'});
 let found=false;
 const visit=node=>{
  if(!node||typeof node!=='object')return;
  if(node.type==='ImportDeclaration'&&node.source.value==='source-map-js')found=true;
  if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='require'&&node.arguments.length===1&&node.arguments[0].type==='StringLiteral'&&node.arguments[0].value==='source-map-js')found=true;
  for(const value of Object.values(node)) if(Array.isArray(value))value.forEach(visit); else if(value&&typeof value==='object')visit(value);
 };
 visit(tree.program);
 return found;
}
assert.equal(importsSourceMap('// require("source-map-js")\nconst text="from \'source-map-js\'";'),false);
if(mode==='candidate') assert.ok(artifacts.some(x=>importsSourceMap(x.code)),'No executable external import');
const external=magicastRequire('source-map-js');
assert.equal(magicastRequire('source-map-js/package.json').version,'1.2.2');
const {SourceMapConsumer,SourceMapGenerator}=external;
const basic={version:3,sources:['synthetic.ts'],names:[],mappings:'AAAA',sourcesContent:['export const value = 1;']};
const indexed=(line,column=0,map=basic)=>({version:3,sections:[{offset:{line,column},map}]});
const inputs=[indexed(1e12),indexed(-1),indexed(1.5),indexed(Infinity),indexed(0,-1),indexed(0,1.5),indexed(6e6,0,indexed(6e6))];
const reject=Consumer=>inputs.map(map=>{try {new Consumer(map);return false;}catch{return true;}});
assert.ok(reject(SourceMapConsumer).every(Boolean));
assert.equal(new SourceMapConsumer(indexed(2)).originalPositionFor({line:3,column:1}).source,'synthetic.ts');
let embeddedRejection=null;
if(mode==='baseline') {
 const code=artifacts.find(x=>x.code.includes('var require_source_map_consumer ='))?.code;
 assert.ok(code);
 const start=code.indexOf('var require_base64 =');
 const end=code.indexOf('//#region node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/source-node.js');
 assert.ok(start>=0&&end>start);
 const context=vm.createContext({inputs});
 // Initialization AND all constructor calls run inside this bounded invocation.
 vm.runInContext('var __commonJSMin=(cb,mod)=>()=>(mod||(cb((mod={exports:{}}).exports,mod),cb=null),mod.exports);'+code.slice(start,end)+`;globalThis.results=inputs.map(map=>{try{new (require_source_map_consumer().SourceMapConsumer)(map);return false;}catch{return true;}});`,context,{timeout:1000});
 embeddedRejection=Array.from(context.results);
 assert.deepEqual(embeddedRejection,inputs.map(()=>false));
}
let generatorCalls=0,consumerCalls=0;
function CountGenerator(...args){generatorCalls++;return new SourceMapGenerator(...args);}
function CountConsumer(...args){consumerCalls++;return new SourceMapConsumer(...args);}
Object.setPrototypeOf(CountGenerator,SourceMapGenerator);
Object.setPrototypeOf(CountConsumer,SourceMapConsumer);
external.SourceMapGenerator=CountGenerator;
external.SourceMapConsumer=CountConsumer;
const magicast=await import(pathToFileURL(entry).href);
const {V8CoverageProvider}=await import('@vitest/coverage-v8/dist/provider.js');
const provider=new V8CoverageProvider();
provider.options={thresholds:{autoUpdate:true}};
provider.ctx={logger:{log:()=>{}}};
const coverage=provider.createCoverageMap();
coverage.addFileCoverage({path:'synthetic.ts',statementMap:{0:{start:{line:1,column:0},end:{line:1,column:1}}},s:{0:1},fnMap:{},f:{},branchMap:{},b:{}});
const forms=[
 'export default { test: {coverage: {thresholds: {lines: 0}}}};',
 'export default defineConfig({ test: {coverage: {thresholds: {lines: 0}}}});',
 'export default mergeConfig({}, defineConfig({ test: {coverage: {thresholds: {lines: 0}}}}));',
 'export default defineConfig(() => ({ test: {coverage: {thresholds: {lines: 0}}}}));'
];
for(let i=0;i<forms.length;i++) {
 const file=path.join(work,`form-${i}.mjs`);fs.writeFileSync(file,forms[i],{flag:'wx'});
 const mod=await provider.parseConfigModule(file);
 let updated=false;
 await provider.updateThresholds({thresholds:[{coverageMap:coverage,thresholds:{lines:0},name:'global'}],configurationFile:mod,onUpdate:()=>{updated=true;}});
 assert.equal(updated,true);
 assert.ok(mod.generate().code.includes('100'));
}
const mod=magicast.parseModule('export default { value: 1 };',{sourceFileName:'original.mjs'});
mod.exports.default.value=2;
const first=magicast.generateCode(mod,{sourceMapName:'generated.mjs.map'});
const second=magicast.parseModule(first.code,{sourceFileName:'generated.mjs'});
const composed=magicast.generateCode(second,{sourceMapName:'composed.mjs.map',inputSourceMap:first.map});
assert.ok(composed.map);
assert.equal(new SourceMapConsumer(composed.map).originalPositionFor({line:1,column:0}).source,'original.mjs');
assert.equal(typeof providerRequire('magicast').parseModule,'function');
if(mode==='candidate') {
 assert.ok(generatorCalls>0,'Magicast did not use the external generator');
 assert.ok(consumerCalls>0,'Magicast did not use the external consumer for composition');
}
assert.equal(loadEnv('test',path.join(work,'fixture'),'VITE_').VITE_MAGICAST_DISK_CANARY,'placeholder-disk-canary');
assert.equal(process.env.MAGICAST_PARENT_CANARY,undefined);
assert.equal(process.env.NODE_OPTIONS,undefined);
const result={node:process.version,mode,remediation:mode==='candidate',magicast:manifest.version,sourceMap:'1.2.2',
 artifacts:artifacts.map(({file,sha256})=>({file,sha256,externalImport:importsSourceMap(artifacts.find(x=>x.file===file).code)})),
 embeddedRejection,externalRejection:reject(SourceMapConsumer),generatorCalls,consumerCalls,configFormsUpdated:4,sourceMapComposition:true,canaryPositiveControl:true};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
'''
