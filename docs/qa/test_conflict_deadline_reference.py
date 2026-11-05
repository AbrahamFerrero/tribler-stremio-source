"""Keep corrected-reference provenance distinct from the historical SHA."""
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from magicast_reproduce import BASE, DEADLINE_PATCH, snapshot
from magicast_collect import EXPECTED_STEPS, verify
from magicast_support import ProbeError

class ReferenceTests(unittest.TestCase):
    def test_default_archive_stays_historical_and_explicit_patch_is_scoped(self):
        with tempfile.TemporaryDirectory(prefix='deadline-reference-') as temporary:
            root=Path(temporary)/'root';root.mkdir()
            (root/'docs/qa').mkdir(parents=True)
            for name in DEADLINE_PATCH:
                target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('corrected '+name)
            archive=io.BytesIO()
            with tarfile.open(fileobj=archive,mode='w') as output:
                for name in [*DEADLINE_PATCH,'src/untouched.ts','package.json']:
                    data=('historical '+name).encode();member=tarfile.TarInfo(name);member.size=len(data);output.addfile(member,io.BytesIO(data))
            class Run:
                def command(self,*args,**kwargs):pass
            for enabled in [False,True]:
                run=Run();run.path=Path(temporary)/str(enabled);run.path.mkdir()
                with patch('magicast_reproduce.git',return_value=archive.getvalue()), patch('magicast_reproduce.prepare_export'):
                    source=snapshot(root,run,'baseline',enabled)
                for name in DEADLINE_PATCH:
                    self.assertEqual((source/name).read_text(),('corrected ' if enabled else 'historical ')+name)
                self.assertEqual((source/'src/untouched.ts').read_text(),'historical src/untouched.ts')
                self.assertEqual((source/'package.json').read_text(),'historical package.json')
    def test_collector_rejects_reference_claim_without_evidence(self):
        with tempfile.TemporaryDirectory(prefix='reference-manifest-') as temporary:
            root=Path(temporary);reference={'originSha':BASE,'kind':'corrected-reference','patchSha256':{'synthetic.ts':'0'*64}}
            results=dict(node='v20.19.0',base=BASE,lockSha256='0'*64,baselineSummary={},candidateSummary={},
                         coverageFiles=0,mapsIdentical=True,syntheticMapsAndCountersIdentical=True,
                         counterDifferences=[],productionEntries=0,artifact={},toolHashes={},reference=reference)
            manifest={'state':'SUCCESS','remediation':True,'runId':root.name,
                      'steps':[{'name':name,'exit':0} for name in EXPECTED_STEPS],'artifacts':{},'results':results}
            path=root/'manifest.json';path.write_text(json.dumps(manifest))
            with self.assertRaises(ProbeError):verify(path)

if __name__=='__main__':unittest.main()
