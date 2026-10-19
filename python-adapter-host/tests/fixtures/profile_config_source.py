"""Project-authored source copied into two temporary addon module paths by tests."""
import json
import os
from pathlib import Path
import time

import xbmcaddon

CONFIG_ENV = "PYTHON_ADAPTER_KODI_PROFILE_CONFIG"
LABEL = __name__.rsplit("_", 1)[-1]
EXPECTED = {
    "sourceModule": __name__,
    "sourceId": "source_" + LABEL,
    "sourceEnabledSetting": "setting_" + LABEL,
    "sourceResponseMode": "none" if LABEL == "a" else "capture-streams",
}
HIDDEN_NAMES = (
    "TRIBLER_API_KEY", "TRIBLER_URL", "SOME_API_TOKEN", "COOKIE_SECRET",
    "PROVIDER_API_KEY", "AUTHORIZATION", "PROVIDER_CREDENTIALS", "PROVIDER_PASSWORD",
    "PYTHON_ADAPTER_KODI_SOURCE_MODULE", "PYTHON_ADAPTER_KODI_SOURCE_ID",
    "PYTHON_ADAPTER_KODI_SOURCE_ENABLED_SETTING", "PYTHON_ADAPTER_KODI_SOURCE_RESPONSE_MODE",
    "PYTHON_ADAPTER_KODI_RESOLVERS_FILE",
)


PRIVACY_NAMES = (
    "KODI_PRIVACY_CANARY_1", "WINDIR", "PATH", "TEMP", "TMP",
    "USERNAME", "USER", "USERPROFILE", "HOME", "COMPUTERNAME", "HOSTNAME",
    "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "USERDOMAIN",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
)
INSPECTED_NAMES = HIDDEN_NAMES + tuple(
    variant for name in PRIVACY_NAMES for variant in (name, name.lower(), name.title())
) + tuple(f"UNRELATED_CANARY_{index:03d}" for index in range(20))


def inspect_environment(media):
    return [{"type": "https", "url": "https://example.invalid/probe.mp4", "metadata": {
        "visible": {name: name in os.environ for name in INSPECTED_NAMES},
        "configMatches": os.environ.get(CONFIG_ENV) == json.dumps(EXPECTED, sort_keys=True, separators=(",", ":")),
        "encodingMatches": os.environ.get("PYTHONIOENCODING") == "utf-8",
        "utf8Matches": os.environ.get("PYTHONUTF8") == "1",
        "limitMatches": os.environ.get("PYTHON_ADAPTER_WORKER_MAX_RESULTS") == "7",
    }}]


class Client:
    def request(self, **kwargs):
        return json.dumps({"streams": [{"infoHash": LABEL * 40, "fileIdx": 7,
                                      "behaviorHints": {"filename": LABEL + ".mkv"}}]})


client = Client()


class source:
    def sources(self, data, host_dict):
        assert json.loads(os.environ[CONFIG_ENV]) == EXPECTED
        assert not any(name in os.environ for name in HIDDEN_NAMES)
        addon = xbmcaddon.Addon()
        assert addon.getSetting(EXPECTED["sourceEnabledSetting"]) == "true"
        if LABEL == "b" and data["title"] == "fail_b":
            raise RuntimeError("private fixture detail")
        if LABEL == "b" and data["title"] == "block_b":
            while True:
                time.sleep(1)
        if data["title"] == "concurrent":
            profile = Path(addon.getAddonInfo("profile"))
            (profile / "ready").write_text("ready")
            while not (profile / "release").exists():
                time.sleep(0.01)
        client.request()
        return [{"hash": LABEL * 40, "name": "Fixture " + LABEL, "source": __name__}]
