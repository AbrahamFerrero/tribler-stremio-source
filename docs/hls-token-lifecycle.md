# HLS token lifecycle

The bridge keeps one bounded, in-memory playback authority for a source token and
its HLS descendants. Each resource still has its own unpredictable 192-bit token,
header scope and isolated representation binding. No upstream URL is encoded in
a public token. This does not change URL, DNS, redirect or recipient-header checks.

An admitted GET or HEAD with a valid `/source/` or `/hls/` token renews the shared
inactivity deadline by `HTTP_STREAM_TOKEN_TTL_SECONDS` (default: one hour).
Admission counts even if the subsequent upstream request fails. Playlist rewriting,
response completion and representation observations do not renew authorization.
Registration checks the captured parent capability again after asynchronous network
and playlist validation work. Expired or evicted parents cannot mint new children.

Activity on any retained child keeps the source, nested playlists, keys, maps and
other retained segments usable. A segment does not need to have been visited before
the original registration deadline. Long playback, late seeks and replay work while
requests keep this authority active. At the inactivity deadline, including equality,
the entire tree loses authority. Subsequent requests cannot revive it. Cleanup on
registration, expiry detection or token-count inspection removes expired entries
and clears their representation bindings; retained observations cannot authorize
conditional requests after expiry, even before cleanup.

Each successful playlist rewrite replaces that exact parent's immediate resource
list. Matching URL, media-segment role, sanitized headers and entry scope reuse the
same child token and binding. Removed children and their descendants are revoked
and their bindings cleared. Unchanged variants retain their own children. Failed
validation leaves the existing list intact. Concurrent rewrites commit synchronously
in completion order; the last completed valid rewrite defines the retained list.
Live reloads therefore do not accumulate an unbounded history. Old live-window
resources are unavailable after removal, even if a player saved their local URLs.

The global HLS registry holds at most 4096 resources; input batches are also limited
to 4096 references, including repeats. Repeated identical references within a batch
share one child token. A new batch is planned before
any eviction. If the retained tree plus its replacement batch exceeds 4096, the
whole registration fails without evicting its ancestors or changing other sessions.
Otherwise capacity pressure evicts entire other HLS trees in least-recent-activity
order; equal deadlines use session registration order. Active trees are eligible.
Whole-tree eviction can free more entries than strictly required. The registering
tree is protected for that commit only. Source capacity retains its separate
`HTTP_STREAM_TOKEN_MAX_ENTRIES` limit; evicting a source also revokes its HLS tree.
Every eviction clears source/child bindings, invalidates held parent capabilities,
and makes all affected tokens unusable. No child survives as an orphan authority.
Session bookkeeping is bounded by source entries plus HLS resource entries.

The legacy `/auto/` route has no stored source-token capability. Each root rewrite
starts a separate bounded HLS tree; nested `/hls/` rewrites inherit it. A fresh
`/auto/` request follows the existing catalog-route behavior and does not revive an
old tree. Internal registrations without a parent likewise start independent trees.
Direct non-HLS source-token inactivity and capacity behavior are unchanged.

Pauses or request gaps lasting the TTL require fresh discovery; receiving bytes on
an already admitted response alone does not extend the deadline. Playback cannot
survive arbitrary inactivity or memory pressure. Already admitted unconditioned
responses may finish after revocation, but cannot renew authority, publish new HLS
children or recreate representation bindings. Availability of retained upstream
resources and upstream credentials is still controlled by the upstream server.
