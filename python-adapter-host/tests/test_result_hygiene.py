from __future__ import annotations

import asyncio
import threading
import unittest

from adapter_host.app import create_server

from adapter_host.config import AdapterSettings
from adapter_host.models import MediaItem
from adapter_host.registry import ResolverRegistry
from adapter_host.resolver import Resolver

ITEM = MediaItem("test", "movie", "Test")
HASH = "a" * 40


class StaticResolver(Resolver):
    def __init__(self, resolver_id, streams):
        self.id = resolver_id
        self.name = resolver_id
        self.streams = streams

    async def resolve(self, item):
        return self.streams


def magnet(seeds=None, *, hash_value=HASH, title=None):
    source = {"type": "magnet", "magnet": f"magnet:?xt=urn:btih:{hash_value}"}
    if seeds is not None:
        source["seeds"] = seeds
    if title is not None:
        source["title"] = title
    return source


class ResultHygieneTests(unittest.IsolatedAsyncioTestCase):
    async def test_seed_filter_and_best_duplicate_evidence(self):
        registry = ResolverRegistry()
        registry.register(StaticResolver("first", [
            magnet(0, hash_value="1" * 40),
            magnet(hash_value=HASH),
            magnet(7, hash_value="b" * 40, title="first"),
            {"type": "https", "url": "https://media.example/first.mp4", "seeds": 0},
        ]))
        registry.register(StaticResolver("second", [
            magnet(14, hash_value=HASH),
            magnet(12, hash_value="b" * 40),
            magnet(5, hash_value="c" * 40, title="first"),
            magnet(0, hash_value="d" * 40),
            {"type": "http", "url": "http://media.example/second.mp4", "seeds": 0},
        ]))
        registry.register(StaticResolver("third", [
            magnet(5, hash_value="c" * 40, title="second"),
            magnet(hash_value="e" * 40),
        ]))
        streams = await registry.resolve(ITEM)
        by_hash = {source.get("infoHash"): source for source in streams if source["type"] == "magnet"}
        self.assertNotIn("1" * 40, by_hash)
        self.assertNotIn("d" * 40, by_hash)
        self.assertEqual(by_hash[HASH]["seeds"], 14)
        self.assertEqual(by_hash["b" * 40]["seeds"], 12)
        self.assertEqual(by_hash["c" * 40]["title"], "second")
        self.assertNotIn("seeds", by_hash["e" * 40])
        self.assertEqual({source["type"] for source in streams if source["type"] != "magnet"},
                         {"http", "https"})

    async def test_same_infohash_across_resolvers_is_globally_unique(self):
        registry = ResolverRegistry()
        first = magnet(5, title="first")
        first["filename"] = "first-file.mkv"
        first["fileIndex"] = 2
        second = magnet(14, title="second")
        second["filename"] = "second-file.mkv"
        second["fileIndex"] = 2
        registry.register(StaticResolver("first", [first]))
        registry.register(StaticResolver("second", [second]))
        streams = await registry.resolve(ITEM)
        self.assertEqual(len(streams), 1)
        self.assertEqual(len({source["infoHash"] for source in streams}), 1)
        self.assertEqual((streams[0]["providerId"], streams[0]["seeds"]),
                         ("second", 14))

    async def test_distinct_file_indexes_remain_eligible(self):
        registry = ResolverRegistry()
        first = magnet(5)
        first["fileIndex"] = 2
        second = magnet(7)
        second["fileIndex"] = 5
        registry.register(StaticResolver("first", [first]))
        registry.register(StaticResolver("second", [second]))
        streams = await registry.resolve(ITEM)
        self.assertEqual({source["fileIndex"] for source in streams}, {2, 5})
        self.assertEqual(len(streams), 2)
    async def test_http_resolve_does_not_reintroduce_duplicate_infohashes(self):
        from tests.test_http_api import HttpApiTests

        registry = ResolverRegistry()
        first = magnet(5)
        first["filename"] = "first.mkv"
        second = magnet(14)
        second["filename"] = "second.mkv"
        registry.register(StaticResolver("first", [first]))
        registry.register(StaticResolver("second", [second]))
        server = create_server(0, registry)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, body = await asyncio.to_thread(
                HttpApiTests._request_server, server, "/resolve",
                {"id": "test", "type": "movie", "title": "Test"})
            self.assertEqual(status, 200)
            self.assertEqual(len(body["streams"]), 1)
            self.assertEqual(body["streams"][0]["seeds"], 14)
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(timeout=2)

    async def test_round_robin_cap_and_determinism(self):
        self.assertEqual(AdapterSettings().max_total_results, 100)
        with self.assertRaises(ValueError):
            AdapterSettings(max_total_results=101)
        with self.assertRaises(ValueError):
            ResolverRegistry(maximum_results=101)
        registry = ResolverRegistry(maximum_results_per_resolver=100)
        for resolver_id in ("first", "second"):
            registry.register(StaticResolver(resolver_id, [
                {"type": "https", "url": f"https://media.example/{resolver_id}-{i}.mp4"}
                for i in range(100)
            ]))
        first = await registry.resolve(ITEM)
        second = await registry.resolve(ITEM)
        self.assertEqual(len(first), 100)
        self.assertEqual(first, second)
        self.assertEqual([source["providerId"] for source in first[:4]],
                         ["first", "second", "first", "second"])
        self.assertEqual(sum(source["providerId"] == "second" for source in first), 50)

    async def test_zero_seed_duplicate_never_displaces_positive(self):
        registry = ResolverRegistry()
        registry.register(StaticResolver("first", [magnet(14)]))
        registry.register(StaticResolver("second", [magnet(0)]))
        self.assertEqual((await registry.resolve(ITEM))[0]["seeds"], 14)


if __name__ == "__main__":
    unittest.main()
