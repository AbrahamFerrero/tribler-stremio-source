from __future__ import annotations

import asyncio
from dataclasses import dataclass
import unittest

from adapter_host.models import MediaItem, StreamSource
from adapter_host.registry import ResolverRegistry
from adapter_host.resolver import Resolver

ITEM = MediaItem("test", "movie", "Test")


class StaticResolver(Resolver):
    def __init__(self, resolver_id: str, streams: list[StreamSource]) -> None:
        self.id = resolver_id
        self.name = resolver_id
        self.streams = streams

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        return self.streams


class FailingResolver(StaticResolver):
    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        raise RuntimeError("private implementation detail")


class SlowResolver(StaticResolver):
    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        await asyncio.sleep(0.05)
        return self.streams


class DelayedResolver(StaticResolver):
    def __init__(self, resolver_id: str, streams: list[StreamSource], delay: float) -> None:
        super().__init__(resolver_id, streams)
        self.delay = delay

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        await asyncio.sleep(self.delay)
        return self.streams


@dataclass
class ConcurrencyTracker:
    active: int = 0
    peak: int = 0


class TrackedResolver(StaticResolver):
    def __init__(self, resolver_id: str, tracker: ConcurrencyTracker) -> None:
        super().__init__(resolver_id, [{"type": "https", "url": f"https://media.example/{resolver_id}.mp4"}])
        self.tracker = tracker

    async def resolve(self, item: MediaItem) -> list[StreamSource]:
        self.tracker.active += 1
        self.tracker.peak = max(self.tracker.peak, self.tracker.active)
        try:
            await asyncio.sleep(0.01)
            return self.streams
        finally:
            self.tracker.active -= 1


class ResolverRegistryTests(unittest.IsolatedAsyncioTestCase):
    async def test_combines_deduplicates_and_can_disable(self) -> None:
        source: StreamSource = {"type": "https", "url": "https://media.example/test.mp4"}
        registry = ResolverRegistry()
        registry.register(StaticResolver("first", [source]))
        registry.register(StaticResolver("second", [source]))
        self.assertEqual(len(await registry.resolve(ITEM)), 1)
        registry.set_enabled("first", False)
        states = registry.list_resolvers()
        self.assertFalse(states[0]["enabled"])
        self.assertEqual(states[0]["status"], "disabled")

    async def test_isolates_failure_and_timeout(self) -> None:
        good: StreamSource = {"type": "https", "url": "https://media.example/good.mp4"}
        registry = ResolverRegistry(default_timeout_seconds=0.01)
        registry.register(FailingResolver("failing", []))
        registry.register(SlowResolver("slow", []))
        registry.register(StaticResolver("good", [good]))
        result = await registry.resolve_with_outcomes(ITEM)
        self.assertEqual(len(result.streams), 1)
        self.assertEqual([(outcome.id, outcome.status, outcome.operational) for outcome in result.outcomes], [
            ("failing", "resolver_error", False), ("slow", "timeout", False), ("good", "ok", True),
        ])
        states = {state["id"]: state for state in registry.list_resolvers()}
        self.assertEqual(states["failing"]["status"], "resolver_error")
        self.assertEqual(states["slow"]["status"], "timeout")
        self.assertNotIn("private implementation detail", str(states))

    async def test_one_timeout_preserves_other_concurrent_results(self) -> None:
        started = asyncio.Event()
        cancelled = asyncio.Event()
        never = asyncio.Event()
        active: set[str] = set()

        class SynchronizedResolver(StaticResolver):
            async def resolve(self, item: MediaItem) -> list[StreamSource]:
                active.add(self.id)
                if len(active) == 3:
                    started.set()
                try:
                    await started.wait()
                    if self.id == "b":
                        await never.wait()
                    elif self.id == "c":
                        # This result must survive while another resolver is cancelled.
                        await cancelled.wait()
                    return self.streams
                except asyncio.CancelledError:
                    if self.id == "b":
                        cancelled.set()
                    raise
                finally:
                    active.remove(self.id)

        # Healthy resolvers have only a deadlock watchdog, no simulated work delay.
        # The blocked resolver is guaranteed not to finish before its real timeout.
        registry = ResolverRegistry(default_timeout_seconds=60, max_concurrent_resolvers=3)
        for name in ("a", "b", "c"):
            resolver = SynchronizedResolver(name, [
                {"type": "https", "url": f"https://media.example/{name}.mp4"},
            ])
            if name == "b":
                resolver.timeout_seconds = 0.06
            registry.register(resolver)
        streams = await registry.resolve(ITEM)
        self.assertEqual({stream["url"] for stream in streams},
                         {"https://media.example/a.mp4", "https://media.example/c.mp4"})
        states = {state["id"]: state["status"] for state in registry.list_resolvers()}
        self.assertEqual(states, {"a": "ok", "b": "timeout", "c": "ok"})
        self.assertTrue(started.is_set())
        self.assertTrue(cancelled.is_set())
        self.assertEqual(active, set())

    async def test_limits_active_resolver_coroutines(self) -> None:
        tracker = ConcurrencyTracker()
        registry = ResolverRegistry(max_concurrent_resolvers=3)
        for index in range(12):
            registry.register(TrackedResolver(f"tracked-{index}", tracker))
        self.assertEqual(len(await registry.resolve(ITEM)), 12)
        self.assertEqual(tracker.peak, 3)

    async def test_caps_each_resolver_and_marks_invalid_output(self) -> None:
        registry = ResolverRegistry(maximum_results_per_resolver=2)
        many = [{"type": "https", "url": f"https://media.example/{index}.mp4"} for index in range(5)]
        registry.register(StaticResolver("many", many))  # type: ignore[arg-type]
        result = await registry.resolve_with_outcomes(ITEM)
        self.assertEqual(len(result.streams), 2)
        self.assertTrue(result.outcomes[0].operational)
        self.assertEqual(result.outcomes[0].status, "invalid_result")
        self.assertEqual(registry.list_resolvers()[0]["status"], "invalid_result")

    async def test_discards_invalid_result_but_keeps_valid_siblings(self) -> None:
        registry = ResolverRegistry()
        registry.register(StaticResolver("mixed", [
            {"type": "https", "url": "https://media.example/good.mp4"},
            {"type": "https", "url": "https://media.example/not-video"},
            {"type": "https", "url": "https://media.example/video.mp4", "metadata": {"x": "y" * 20_000}},
        ]))  # type: ignore[arg-type]
        result = await registry.resolve_with_outcomes(ITEM)
        self.assertEqual([source["url"] for source in result.streams], [
            "https://media.example/good.mp4", "https://media.example/not-video",
        ])
        self.assertTrue(result.outcomes[0].operational)
        self.assertEqual(result.outcomes[0].status, "invalid_result")
        state = registry.list_resolvers()[0]
        self.assertEqual(state["status"], "invalid_result")
        self.assertEqual(state["lastError"], "invalid_result")

    async def test_caps_total_results_after_combining_resolvers(self) -> None:
        registry = ResolverRegistry(maximum_results=3, maximum_results_per_resolver=3)
        registry.register(StaticResolver("one", [
            {"type": "https", "url": f"https://media.example/one-{index}.mp4"} for index in range(3)
        ]))  # type: ignore[arg-type]
        registry.register(StaticResolver("two", [
            {"type": "https", "url": f"https://media.example/two-{index}.mp4"} for index in range(3)
        ]))  # type: ignore[arg-type]
        result = await registry.resolve_with_outcomes(ITEM)
        self.assertEqual(len(result.streams), 3)
        self.assertEqual([outcome.id for outcome in result.outcomes], ["one", "two"])
        self.assertTrue(all(outcome.operational for outcome in result.outcomes))

    async def test_outcomes_snapshot_participation_and_do_not_follow_diagnostics(self) -> None:
        registry = ResolverRegistry()
        resolver = StaticResolver("profile", [])
        registry.register(resolver)
        registry.register(FailingResolver("disabled", []), enabled=False)
        first = await registry.resolve_with_outcomes(ITEM)
        self.assertEqual(first.streams, [])
        self.assertEqual([(outcome.id, outcome.operational) for outcome in first.outcomes], [("profile", True)])
        resolver.streams = [{"type": "https", "url": "https://media.example/payload.exe"}]
        second = await registry.resolve_with_outcomes(ITEM)
        self.assertEqual([(outcome.status, outcome.operational) for outcome in second.outcomes],
                         [("invalid_result", False)])
        self.assertEqual((first.outcomes[0].status, first.outcomes[0].operational), ("ok", True))
        registry.set_enabled("profile", False)
        self.assertEqual((await registry.resolve_with_outcomes(ITEM)).outcomes, ())
        self.assertEqual(await registry.resolve_all(ITEM), [])

    async def test_invalid_root_or_iteration_failure_is_not_operational(self) -> None:
        def broken():
            yield {"type": "https", "url": "https://media.example/good.mp4"}
            raise RuntimeError("private iterator error")

        for output in (None, "invalid", {"type": "https"}, broken()):
            with self.subTest(root=type(output).__name__):
                registry = ResolverRegistry()
                registry.register(StaticResolver("malformed", output))
                result = await registry.resolve_with_outcomes(ITEM)
                self.assertEqual(result.streams, [])
                self.assertEqual((result.outcomes[0].status, result.outcomes[0].operational),
                                 ("invalid_result", False))


if __name__ == "__main__":
    unittest.main()
