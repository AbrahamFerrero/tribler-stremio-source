from __future__ import annotations

import logging
import os

from .app import create_server
from .config import AdapterSettings, require_isolated_host_environment


def main() -> None:
    try:
        require_isolated_host_environment()
        logging.basicConfig(level=os.getenv("PYTHON_ADAPTER_LOG_LEVEL", "INFO").upper(),
                            format="%(asctime)s %(levelname)s %(name)s %(message)s")
        port = int(os.getenv("PYTHON_ADAPTER_PORT", "7100"))
        settings = AdapterSettings.from_environment()
        server = create_server(port, settings=settings)
    except (ValueError, OSError):
        # Startup configuration can contain local paths or sensitive values.
        raise SystemExit("Adapter startup refused: invalid configuration or forbidden Tribler environment") from None
    logging.getLogger("adapter_host").info("Adapter listening on http://127.0.0.1:%s", port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
