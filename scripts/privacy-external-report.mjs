// Sanitize local observations from a controlled BitTorrent observer. This is
// an evaluator, not an observer or a second BitTorrent client.
import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

const userIp = process.env.PRIVACY_USER_PUBLIC_IP;
const fixtureHash = process.env.PRIVACY_FIXTURE_INFOHASH?.toLowerCase();
if (!userIp || !isIP(userIp) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fixtureHash ?? "")) {
  process.stderr.write("Set PRIVACY_USER_PUBLIC_IP and PRIVACY_FIXTURE_INFOHASH locally.\n");
  process.exitCode = 1;
} else {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 65_536) throw new Error("oversized");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object") throw new Error("invalid");
    const canonicalIp = (ip) => !isIP(ip ?? "") ? undefined : isIP(ip) === 4 ? ip
      : new URL(`http://[${ip}]/`).hostname.toLowerCase();
    const classify = (ip) => !canonicalIp(ip) ? "UNKNOWN_IP"
      : canonicalIp(ip) === canonicalIp(userIp) ? "USER_IP" : "OTHER_IP";
    const observed = (run) => {
      const peer = run?.peer;
      if (!peer) return { evidenceCompleteness: "NOT_RUN", source: "UNKNOWN_IP",
        portObserved: false, timestampObserved: false, pieceReceived: false };
      const hashMatches = run.infohash?.toLowerCase() === fixtureHash;
      const portObserved = Number.isSafeInteger(peer.sourcePort) && peer.sourcePort > 0 && peer.sourcePort <= 65_535;
      const timestampObserved = typeof peer.timestamp === "string" && !Number.isNaN(Date.parse(peer.timestamp));
      const pieceReceived = Number.isSafeInteger(peer.pieceBytes) && peer.pieceBytes > 0;
      const complete = hashMatches && portObserved && timestampObserved && peer.handshake === true &&
        peer.bitfield === true && peer.unchoke === true && pieceReceived && isIP(peer.sourceIp ?? "");
      return { evidenceCompleteness: complete ? "COMPLETE" : "INCOMPLETE", source: classify(peer.sourceIp),
        portObserved, timestampObserved, handshake: peer.handshake === true,
        bitfield: peer.bitfield === true, unchoke: peer.unchoke === true, pieceReceived,
        fixtureHashMatches: hashMatches };
    };
    const control = observed(input.control);
    const anonymous = observed(input.anonymous);
    const peerControl = control.evidenceCompleteness === "COMPLETE" && control.source === "USER_IP" ? "PASS"
      : control.evidenceCompleteness === "NOT_RUN" ? "NOT_RUN_EXTERNAL" : "INCONCLUSIVE";
    const peerAnonymous = anonymous.fixtureHashMatches && anonymous.handshake && anonymous.pieceReceived &&
      anonymous.source === "USER_IP" ? "FAIL"
      : anonymous.evidenceCompleteness === "COMPLETE" && anonymous.source === "OTHER_IP" ? "PASS"
      : anonymous.evidenceCompleteness === "NOT_RUN" ? "NOT_RUN_EXTERNAL" : "INCONCLUSIVE";
    const tracker = input.anonymous?.tracker;
    const trackerMatches = tracker?.infohash?.toLowerCase() === fixtureHash;
    const trackerSource = classify(tracker?.sourceIp);
    const trackerComplete = trackerMatches && Number.isSafeInteger(tracker?.sourcePort) &&
      tracker.sourcePort > 0 && typeof tracker.timestamp === "string" &&
      !Number.isNaN(Date.parse(tracker.timestamp));
    const trackerResult = !tracker ? "NOT_RUN_EXTERNAL"
      : trackerMatches && trackerSource === "USER_IP" ? "FAIL"
      : !trackerComplete ? "INCONCLUSIVE"
      : trackerSource === "OTHER_IP" ? "PASS" : "INCONCLUSIVE";
    const webseed = input.anonymous?.webseed;
    const webseedSource = classify(webseed?.sourceIp);
    const webseedResult = !webseed ? "NOT_RUN_EXTERNAL"
      : !Number.isSafeInteger(webseed.responseBytes) || webseed.responseBytes <= 0 ? "INCONCLUSIVE"
      : webseedSource === "USER_IP" ? "FAIL" : webseedSource === "OTHER_IP" ? "PASS" : "INCONCLUSIVE";
    const salt = randomBytes(32);
    const fingerprint = (value) => typeof value === "string" && value ?
      createHmac("sha256", salt).update(value).digest("hex").slice(0, 16) : undefined;
    const controlPeerId = fingerprint(input.control?.peer?.peerId);
    const anonymousPeerId = fingerprint(input.anonymous?.peer?.peerId);
    process.stdout.write(`${JSON.stringify({
      reportBasedOnSuppliedObservations: true,
      observerControl: { ...control, result: peerControl },
      observerAnonymous: { ...anonymous, result: peerAnonymous },
      trackerAnonymous: { result: trackerResult, source: trackerSource,
        portObserved: Number.isSafeInteger(tracker?.sourcePort),
        timestampObserved: typeof tracker?.timestamp === "string" && !Number.isNaN(Date.parse(tracker.timestamp)) },
      webseedAnonymous: { result: webseedResult, source: webseedSource },
      peerId: { controlEphemeralHash: controlPeerId ?? null,
        anonymousEphemeralHash: anonymousPeerId ?? null,
        sameAcrossModes: controlPeerId && anonymousPeerId ? controlPeerId === anonymousPeerId : null,
        correlationResult: "INCONCLUSIVE" },
      dht: "NOT_TESTED", pex: "NOT_TESTED",
      limitation: "OTHER_IP is not independently identified as a Tribler exit IP. A single run cannot prove absence of other discovery leaks."
    })}\n`);
  } catch {
    process.stderr.write("Invalid controlled observer input; no raw observations were printed.\n");
    process.exitCode = 1;
  }
}
