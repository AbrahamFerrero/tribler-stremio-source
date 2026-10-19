export class TriblerStreamingMetrics {
  streamsStarted = 0; streamsCompleted = 0; streamsAborted = 0;
  resolveCount = 0; resolveMs = 0; metadataWaitCount = 0; metadataWaitMs = 0;
  fileSelectionCount = 0; fileSelectionMs = 0; resumePreparationCount = 0; resumePreparationMs = 0;
  upstreamHeaderCount = 0; upstreamHeaderMs = 0;
  upstreamFirstByteCount = 0; upstreamFirstByteMs = 0;
  bridgeFirstByteCount = 0; bridgeFirstByteMs = 0;
  upstreamBytes = 0; downstreamBytes = 0; underrunCount = 0; underrunMs = 0;
  bufferHighWaterBytes = 0; producerWaitCount = 0; consumerWaitCount = 0;
  producerWaitMs = 0; startupPrebufferCount = 0; startupPrebufferBytes = 0; startupPrebufferMs = 0;
  seekPrebufferCount = 0; seekPrebufferBytes = 0; seekPrebufferMs = 0;
  snapshot(): Record<string, number> { return { streamsStarted: this.streamsStarted, streamsCompleted: this.streamsCompleted,
    streamsAborted: this.streamsAborted, upstreamBytes: this.upstreamBytes, downstreamBytes: this.downstreamBytes,
    resolveCount: this.resolveCount, resolveMs: this.resolveMs, metadataWaitCount: this.metadataWaitCount,
    metadataWaitMs: this.metadataWaitMs, fileSelectionCount: this.fileSelectionCount, fileSelectionMs: this.fileSelectionMs,
    resumePreparationCount: this.resumePreparationCount, resumePreparationMs: this.resumePreparationMs,
    upstreamHeaderCount: this.upstreamHeaderCount, upstreamHeaderMs: this.upstreamHeaderMs,
    upstreamFirstByteCount: this.upstreamFirstByteCount, upstreamFirstByteMs: this.upstreamFirstByteMs,
    bridgeFirstByteCount: this.bridgeFirstByteCount, bridgeFirstByteMs: this.bridgeFirstByteMs,
    underrunCount: this.underrunCount, underrunMs: this.underrunMs, bufferHighWaterBytes: this.bufferHighWaterBytes,
    producerWaitCount: this.producerWaitCount, producerWaitMs: this.producerWaitMs, consumerWaitCount: this.consumerWaitCount,
    startupPrebufferCount: this.startupPrebufferCount, startupPrebufferBytes: this.startupPrebufferBytes, startupPrebufferMs: this.startupPrebufferMs,
    seekPrebufferCount: this.seekPrebufferCount, seekPrebufferBytes: this.seekPrebufferBytes, seekPrebufferMs: this.seekPrebufferMs }; }
}
