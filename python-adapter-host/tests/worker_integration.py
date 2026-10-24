"""Budgets and controlled startup latency for real synthetic worker tests."""
from contextlib import contextmanager
from unittest.mock import patch

from adapter_host.kodi.process_manager import KodiWorkerProcessManager

# CI killed a recovery worker ~1.047s after creation; completion time is unknown.
# Allow controlled 1.2s startup plus real imports/IPC; do not change production.
HEALTHY_WORKER_SECONDS = 3
# Includes process creation (outside the worker deadline) and owned cleanup.
RESOLVER_SECONDS = 6
# HTTP can run several resolver waves; the client must outlive the server.
REQUEST_SECONDS = 15
CLIENT_SECONDS = 17
BLOCKED_WORKER_SECONDS = 0.3


@contextmanager
def delayed_worker_start(seconds):
    """Delay initialization in the real child, then run the unchanged worker.

    This is a controlled scheduling surrogate, not a claim about CI's latency
    source. Production environment, arguments, pipes and Job assignment remain.
    """
    arguments = KodiWorkerProcessManager._arguments

    def delayed(manager, *args, **kwargs):
        command = arguments(manager, *args, **kwargs)
        bootstrap = (
            "import runpy,sys,time; "
            f"time.sleep({float(seconds)!r}); "
            "sys.argv=['adapter_host.kodi.worker',*sys.argv[1:]]; "
            "runpy.run_module('adapter_host.kodi.worker',run_name='__main__')"
        )
        return [command[0], "-B", "-c", bootstrap, *command[4:]]

    with patch.object(KodiWorkerProcessManager, "_arguments", delayed):
        yield
