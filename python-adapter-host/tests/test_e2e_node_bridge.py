from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import socket
import time
import tempfile
import unittest
from urllib.request import urlopen


class NodeBridgeEndToEndTest(unittest.TestCase):
    def test_node_external_provider_calls_live_python_adapter(self) -> None:
        self.run_node_adapter()

    def test_node_external_provider_calls_configured_callable_worker(self) -> None:
        host_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "profiles.json"
            profile_path = root / "profile"
            config.write_text(json.dumps({"version": 1, "profiles": [{
                "id": "callable_fixture", "name": "Callable fixture", "enabled": True,
                "addonPath": str(host_root / "tests" / "fixtures" / "fake_kodi_addon"),
                "addonId": "script.module.fake", "profilePath": str(profile_path),
                "module": "adapter_host.kodi.adapters.callable_stream_resolver", "callable": "resolve",
                "workerTimeoutSeconds": 1.5,
                "adapterConfig": {"targetModule": "callable_stream_fixture",
                                  "targetCallable": "get_stream_data", "resultMode": "tuple"},
            }]}), encoding="utf-8")
            streams = [stream for stream in self.run_node_adapter(config)
                       if not stream.get("metadata", {}).get("example")]
            self.assertEqual(len(streams), 2)
            self.assertEqual(streams[0]["url"], "https://1.1.1.1/fixture-video.mp4")
            self.assertEqual(streams[1]["infoHash"], "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c")
            self.assertEqual(streams[1]["fileIndex"], 0)
            self.assertNotIn("do-not-expose", json.dumps(streams))
            self.assertTrue(all("headers" not in stream and "metadata" not in stream for stream in streams))
            arguments = json.loads((profile_path / "arguments.json").read_text())
            self.assertEqual((arguments["imdb_id"], arguments["override_title"], arguments["override_year"]),
                             ("tt1254207", "Big Buck Bunny", 2008))

    def test_node_external_provider_calls_source_pack_worker(self) -> None:
        host_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "profiles.json"
            config.write_text(json.dumps({"version": 1, "profiles": [{
                "id": "source_pack_fixture", "name": "Source pack fixture", "enabled": True,
                "addonPath": str(host_root / "tests" / "fixtures" / "fake_kodi_addon"),
                "addonId": "script.module.fake", "profilePath": str(root / "profile"),
                "module": "adapter_host.kodi.adapters.source_pack", "callable": "resolve",
                "workerTimeoutSeconds": 1.5,
                "adapterConfig": {"sourcePackage": "fixture_sources", "sourceFolders": ["en"],
                                  "maxProviderWorkers": 2},
            }]}), encoding="utf-8")
            streams = [stream for stream in self.run_node_adapter(config)
                       if not stream.get("metadata", {}).get("example")]
            self.assertEqual([stream["url"] for stream in streams], [
                "https://1.1.1.1/source-pack.mp4", "https://1.1.1.1/resolved.m3u8",
                "https://1.1.1.1/api/embed",
            ])
            self.assertTrue(all(stream["type"] == "https" for stream in streams))
            self.assertNotIn("private", json.dumps(streams))
            self.assertTrue(all("headers" not in stream and "metadata" not in stream for stream in streams))

    def run_node_adapter(self, config_file: Path | None = None):
        host_root = Path(__file__).resolve().parents[1]
        repository_root = host_root.parent
        executable = repository_root / "node_modules" / ".bin" / ("tsx.cmd" if os.name == "nt" else "tsx")
        self.assertTrue(executable.exists(), "Run npm install in the bridge before the E2E test")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        environment = {key: value for key, value in os.environ.items()
                       if key not in {"TRIBLER_API_KEY", "TRIBLER_URL"}
                       and not key.startswith("PYTHON_ADAPTER_KODI_")}
        environment["PYTHON_ADAPTER_PORT"] = str(port)
        environment["PYTHON_ADAPTER_KODI_RESOLVER_ENABLED"] = "true"
        environment["PYTHON_ADAPTER_KODI_ADDON_PATH"] = str(host_root / "tests" / "fixtures" / "fake_kodi_addon")
        environment["PYTHON_ADAPTER_KODI_MODULE"] = "fake_kodi_module"
        environment["PYTHON_ADAPTER_KODI_ADDON_ID"] = "script.module.fake"
        environment["PYTHON_ADAPTER_KODI_SETTINGS_FILE"] = str(
            host_root / "tests" / "fixtures" / "fake_kodi_addon" / "settings.example.json"
        )
        if config_file is not None:
            environment = {key: value for key, value in environment.items()
                           if not key.startswith("PYTHON_ADAPTER_KODI_")}
            environment["PYTHON_ADAPTER_KODI_RESOLVERS_FILE"] = str(config_file)
        self.assertNotIn("TRIBLER_API_KEY", environment)
        self.assertNotIn("TRIBLER_URL", environment)
        adapter = subprocess.Popen(
            [sys.executable, "-m", "adapter_host"],
            cwd=host_root,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        try:
            deadline = time.monotonic() + 3
            while True:
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=0.2):
                        break
                except OSError:
                    if adapter.poll() is not None or time.monotonic() >= deadline:
                        _, stderr = adapter.communicate(timeout=1)
                        self.fail(f"adapter did not start: {stderr}")
                    time.sleep(0.05)
            url = f"http://127.0.0.1:{port}/resolve"
            result = subprocess.run(
                [str(executable), str(repository_root / "tests" / "fixtures" / "python-adapter-client.ts"), url],
                cwd=repository_root,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=15,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            streams = json.loads(result.stdout)["streams"]
            self.assertEqual({stream["type"] for stream in streams}, {"https", "magnet"})
            self.assertTrue(all(stream["providerId"] == "python_adapter" for stream in streams))
            if config_file is not None:
                return streams
            self.assertEqual(streams[0]["metadata"]["example"], True)
            fixture_stream = next(stream for stream in streams if stream.get("metadata", {}).get("fixture"))
            self.assertTrue(fixture_stream["metadata"]["setting"])
            self.assertTrue(fixture_stream["metadata"]["pathConfined"])
            self.assertFalse(fixture_stream["metadata"]["triblerApiKeyVisible"])
            self.assertFalse(fixture_stream["metadata"]["triblerUrlVisible"])
        finally:
            adapter.terminate()
            try:
                adapter.wait(timeout=3)
            except subprocess.TimeoutExpired:
                adapter.kill()
                adapter.wait(timeout=2)
            adapter.communicate(timeout=1)


if __name__ == "__main__":
    unittest.main()
