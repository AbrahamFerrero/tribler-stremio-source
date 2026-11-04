import { createHash } from "node:crypto";
import { diagnosticTranslations, validateDiagnosticTranslations, type DiagnosticDictionary } from "./i18n";
import { validateDiagnosticExport } from "./private-context";
import { DIAGNOSTIC_LIMITS } from "./recorder";
import { HTML_REPORT_MAX_BYTES } from "./export-file";
import { DiagnosticCliError } from "./cli-errors";

export function escapeDiagnosticHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
export function embedDiagnosticJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Static, dependency-free browser code. Data enters the DOM only through textContent.
export const diagnosticReportScript = String.raw`"use strict";
(function () {
  const exported = JSON.parse(document.getElementById("diagnostic-data").textContent);
  const data = exported.privacy === "PRIVATE_LOCAL" ? exported.report : exported;
  const privateContexts = exported.privacy === "PRIVATE_LOCAL" ? exported.context : [];
  const dictionaries = JSON.parse(document.getElementById("diagnostic-translations").textContent);
  const limits = JSON.parse(document.getElementById("diagnostic-limits").textContent);
  const language = document.getElementById("language");
  const phase = document.getElementById("phase");
  const state = document.getElementById("state-filter");
  const candidate = document.getElementById("candidate-filter");
  const searchFilter = document.getElementById("resolution-filter");
  const stages = ["PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"];
  const scores = ["score", "availability", "resolution", "size", "codec", "metadata", "transport"];
  const rows = [];
  const candidates = new Map();
  const sourceOrdinals = new Map();
  for (const resolution of data.resolutions) {
    for (const event of resolution.events) {
      const row = { resolutionId: resolution.id, event: event };
      rows.push(row);
      if (event.candidateId && event.candidateId !== "UNOBSERVED") {
        const key = resolution.id + ":" + event.candidateId;
        if (!candidates.has(key)) {
          const ordinal = (sourceOrdinals.get(resolution.id) || 0) + 1; sourceOrdinals.set(resolution.id, ordinal);
          candidates.set(key, { id: event.candidateId, resolutionId: resolution.id, ordinal, rows: [] });
        }
        candidates.get(key).rows.push(row);
      }
    }
  }
  let dict = dictionaries.en;
  let selectedKey = "";
  const providerFilter = document.getElementById("provider-filter");
  const outcomeFilter = document.getElementById("outcome-filter");
  // Candidate keys always include the resolution; UUID reuse cannot join searches.
  const evidenceCache = new Map();
  function evidence(c) {
    if (evidenceCache.has(c)) return evidenceCache.get(c);
    const events = c.rows.map(r => r.event);
    const resolution = data.resolutions.find(r => r.id === c.resolutionId);
    const source = events.filter(e => e.kind === "SOURCE").at(-1);
    const rejection = events.find(e => e.kind === "REJECTION" || e.kind === "EXCLUSION") ||
      (events.some(e => e.kind === "PRE_PROBE" && e.decision === "REJECT") ? { stage: "NORMALIZED", reason: "INSUFFICIENT_EVIDENCE" } : undefined);
    const reached = stages.filter(stage => events.some(e =>
      e.kind === "OBSERVATION" && e.stage === stage || e.kind === "SOURCE" && stage === "PROVIDER"));
    const lastEvidence = stages.filter(stage => reached.includes(stage) || rejection && rejection.stage === stage).at(-1);
    const final = events.some(e => e.kind === "OBSERVATION" && e.stage === "FINAL");
    const gap = events.find(e => e.kind === "GAP" && e.context === "CONTINUITY");
    const incomplete = resolution.state !== "CLOSED";
    const result = { events, source, rejection, reached, lastEvidence, final, gap, incomplete };
    evidenceCache.set(c, result); return result;
  }
  function stageEvidence(c, stage) {
    const v = evidence(c);
    if (v.rejection && v.rejection.stage === stage) return ["rejected", "×", dict.explicitRejected + ": " + label(v.rejection.reason)];
    if (v.reached.includes(stage)) return ["observed", "●", dict.positiveObservation];
    if (v.incomplete) return ["incomplete", "◒", dict.captureIncomplete];
    if (v.gap && v.gap.stage === stage && !v.rejection && !v.final) return ["unknown", "?", dict.unknownDisappearance];
    return ["unavailable", "—", dict.observationUnavailable];
  }
  function sourceMatches(c) {
    const v = evidence(c);
    return c.rows.some(matches) && (!providerFilter.value || String(v.source && v.source.provider) === providerFilter.value) &&
      (!outcomeFilter.value || (outcomeFilter.value === "final" && v.final) ||
      (outcomeFilter.value === "rejected" && v.rejection) ||
      (outcomeFilter.value === "unknown" && v.gap && !v.rejection && !v.final));
  }
  function selectSource(c) {
    selectedKey = c.resolutionId + ":" + c.id;
    renderInspector();
    for (const row of document.getElementById("sources-human").children) row.setAttribute("aria-selected", String(row.getAttribute("data-key") === selectedKey));
    document.getElementById("inspector-heading").focus();
  }
  function renderInspector() {
    const panel = document.getElementById("source-inspector"); panel.replaceChildren();
    const c = candidates.get(selectedKey);
    const heading = text(panel, "h2", c ? sourceName(c) : dict.inspector);
    heading.setAttribute("id", "inspector-heading"); heading.setAttribute("tabindex", "-1");
    if (!c) { text(panel, "p", dict.selectSource); return; }
    const v = evidence(c);
    text(panel, "p", providerName(c.resolutionId, v.source && v.source.provider));
    text(panel, "p", (v.source ? label(v.source.transport) : dict.UNOBSERVED) + " · " + (v.source && v.source.height ? v.source.height + "p" : dict.qualityMissing));
    text(panel, "strong", v.final ? dict.selectedSource : v.rejection ? dict.explicitRejected + ": " + label(v.rejection.reason) : v.gap ? dict.unknownDisappearance : dict.observationUnavailable);
    if (v.rejection && v.rejection.kind === "EXCLUSION" && v.rejection.reason === "DETERMINISTIC_PROBE_REJECTION") text(panel, "p", probeEvidence(v.rejection));
    if (v.rejection && v.rejection.kind === "EXCLUSION" && v.rejection.reason === "HLS_NOT_VERIFIED") text(panel, "p", hlsEvidence(v.rejection));
    const direct = v.events.filter(e => e.kind === "DIRECT_MEDIA" || e.kind === "DIRECT_MEDIA_SIGNATURE").at(-1);
    if (direct) { text(panel, "p", directEvidence(direct)); text(panel, "p", dict.directMediaNotice); }
    else if (v.rejection && v.rejection.reason === "DIRECT_MEDIA_NOT_VERIFIED") text(panel, "p", dict.directMediaNotCaptured);
    text(panel, "p", dict.stagesReached + ": " + (v.reached.map(label).join(" → ") || dict.UNOBSERVED));
    text(panel, "p", dict.lastStage + ": " + (v.lastEvidence ? label(v.lastEvidence) : dict.UNOBSERVED));
    const context = privateContexts.find(context => context.resolutionId === c.resolutionId);
    if (context) {
      text(panel, "p", dict.requestedTitle + ": " + (context.title || dict.contentMissing));
      text(panel, "h3", dict.declaredMetadata);
      const declared = (context.candidates || []).find(m => m.candidateId === c.id);
      for (const [field, key] of [["name", "declaredName"], ["title", "declaredTitle"], ["identityTitle", "declaredIdentityTitle"]]) {
        const status = declared && declared.labelStatus && declared.labelStatus[field];
        const missing = context.metadataCapture && context.metadataCapture !== "WITHIN_LIMITS" ? dict["metadata" + context.metadataCapture] : dict.metadataMissing;
        text(panel, "p", dict[key] + ": " + (declared && declared[field] || (status ? dict["metadata" + status] : missing)));
        const reason = status === "WITHHELD" && declared.labelReasons && declared.labelReasons[field];
        if (reason && dict["labelReason" + reason]) text(panel, "p", dict["labelReason" + reason]);
      }
      if (context.metadataCapture && context.metadataCapture !== "WITHIN_LIMITS") text(panel, "p", dict["metadata" + context.metadataCapture]);
      text(panel, "p", dict.declaredCoordinates + ": " + (declared ? dict.season + ": " + (declared.season === null ? dict.UNOBSERVED : declared.season) + "; " + dict.episode + ": " + (declared.episode === null ? dict.UNOBSERVED : declared.episode) : dict.metadataMissing));
    }
    const preliminary = v.events.filter(e => e.kind === "PRE_PROBE").at(-1);
    const identity = v.events.filter(e => e.kind !== "PRE_PROBE" && e.identity !== undefined).at(-1);
    const probe = v.events.filter(e => e.probe !== undefined).at(-1);
    const lastObservation = v.events.filter(e => e.kind === "OBSERVATION").at(-1);
    if (v.gap && !v.rejection && lastObservation) text(panel, "p", dict.lastAvailableEvidence + ": " + label(lastObservation.stage) + "; " + label(lastObservation.probe));
    text(panel, "p", dict.identity + ": " + (identity ? label(identity.identity) : dict.UNOBSERVED));
    if (preliminary) text(panel, "p", dict.preliminaryIdentity + ": " + code(preliminary.identity));
    if (preliminary && preliminary.identity === "UNKNOWN" && (!identity || identity.identity === "UNCLASSIFIED")) text(panel, "p", dict.preliminaryIdentityNotice);
    text(panel, "p", dict.probe + ": " + (probe ? label(probe.probe) : dict.UNOBSERVED));
    if (v.incomplete) text(panel, "p", dict.resolutionIncomplete);
    else if ((v.rejection && v.rejection.kind !== undefined || v.final) && !v.gap) text(panel, "p", dict.sourceTraceComplete);
    if (data.state === "TRUNCATED") text(panel, "p", dict.globalIncomplete);
    const rank = v.events.filter(e => e.kind === "RANKING").at(-1);
    text(panel, "p", dict.position + ": " + (rank ? rank.position : dict.UNOBSERVED));
    if (rank) for (const key of scores) text(panel, "p", label(key) + ": " + rank[key]);
    else text(panel, "p", dict.scoreDetails + ": " + dict.UNOBSERVED);
    const advanced = document.createElement("details"); panel.appendChild(advanced);
    text(advanced, "summary", dict.technicalDetails);
    text(advanced, "p", dict.candidateId + ": " + c.id);
    text(advanced, "p", dict.resolutionId + ": " + c.resolutionId);
    for (const e of v.events) text(advanced, "p", code(e.kind) + " · " + eventDetails(e));
  }
  function label(key) { return dict[key] || dict.UNOBSERVED; }
  function code(value) { return label(value) + " [" + value + "]"; }
  function probeEvidence(e) {
    let detail = e.probeCause ? label(e.probeCause) : dict.probeCauseNotCaptured;
    if (e.probeCause === "HTTP_CLIENT_ERROR") detail = "HTTP " + e.httpStatus + " — " + (dict["probeHttp" + e.httpStatus] || dict.probeHttpOther);
    return dict.probeCause + ": " + detail;
  }
  function eventDetails(e) {
    if (e.kind === "DIRECT_MEDIA" || e.kind === "DIRECT_MEDIA_SIGNATURE") return directEvidence(e);
    const details = Object.entries(e).filter(([key]) => !["candidateId", "kind", "probeCause", "httpStatus", "hlsPhase", "hlsCause"].includes(key))
      .map(([key, val]) => label(key) + ": " + value(key, val));
    if (e.kind === "EXCLUSION" && e.reason === "DETERMINISTIC_PROBE_REJECTION") details.push(probeEvidence(e));
    if (e.kind === "EXCLUSION" && e.reason === "HLS_NOT_VERIFIED") details.push(hlsEvidence(e));
    return details.join("; ");
  }
  function hlsEvidence(e) {
    const cause = e.hlsCause === "HTTP_RESPONSE" ? "HTTP " + e.httpStatus + " — " + (dict["probeHttp" + e.httpStatus] || dict.hlsHttpResponse)
      : e.hlsCause ? label(e.hlsCause) : dict.probeCauseNotCaptured;
    return dict.hlsFailureDetail + ": " + (e.hlsPhase ? label(e.hlsPhase) : dict.hlsPhaseNotCaptured) + " · " + cause;
  }
  function directEvidence(e) {
    if (e.kind === "DIRECT_MEDIA_SIGNATURE") return label(e.kind) + ": "
      + ["container", "mime", "response", "range", "verified"].map(key => label(key) + ": " + value(key, e[key])).join("; ")
      + "; " + dict.signatureNotice;
    return label("DIRECT_MEDIA") + ": " + ["filename", "urlName", "mime", "media", "mediaCause", "response", "range", "verified"].map(key => label(key) + ": " + (key === "media" && e[key] === "ADMITTED" ? dict.directMediaAdmitted : value(key, e[key]))).join("; ")
      + "; " + dict.probe + ": " + label(e.transport);
  }
  function value(field, v) {
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? dict.yes : dict.no;
    if (field === "candidateId" || field === "resolutionId" || field === "session") return v;
    return code(v);
  }
  function cell(row, text) { const td = document.createElement("td"); td.textContent = text; row.appendChild(td); return td; }
  function line(body, texts) { const tr = document.createElement("tr"); for (const text of texts) cell(tr, text); body.appendChild(tr); return tr; }
  function option(select, key, text) { const o = document.createElement("option"); o.value = key; o.textContent = text; select.appendChild(o); }
  function fillSelect(select, keys, raw) {
    const old = select.value; select.replaceChildren(); option(select, "", dict.all);
    for (const key of keys) {
      const c = raw && [...candidates.values()].find(c => c.id === key && c.resolutionId === searchFilter.value);
      option(select, key, c ? dict.searchLabel + " " + (data.resolutions.findIndex(r => r.id === c.resolutionId) + 1) + " / " + sourceName(c) : code(key));
    }
    select.value = keys.includes(old) ? old : "";
  }
  function rowStates(row) {
    const e = row.event; const values = [e.identity, e.outcome, e.reason, e.probe, e.category].filter(Boolean);
    return values.length ? values : ["UNOBSERVED"];
  }
  function matches(row) {
    const e = row.event;
    return (!searchFilter.value || row.resolutionId === searchFilter.value) && (!phase.value || (e.stage || "UNOBSERVED") === phase.value) &&
      (!state.value || rowStates(row).includes(state.value)) && (!candidate.value || e.candidateId === candidate.value);
  }
  function text(parent, tag, value) { const n = document.createElement(tag); n.textContent = value; parent.appendChild(n); return n; }
  function sourceName(c) { return dict.sourceLabel + " " + c.ordinal; }
  function providerName(resolutionId, ordinal) {
    if (ordinal === undefined || ordinal < 0) return dict.sourceOriginUnknown;
    const context = privateContexts.find(c => c.resolutionId === resolutionId);
    const provider = context && context.providers.find(p => p.provider === ordinal);
    const alias = dict.providerLabel + " " + (ordinal + 1);
    return provider && (provider.name || provider.id) ? (provider.name || provider.id) + (provider.id && provider.id !== provider.name ? " (" + provider.id + ")" : "") : alias;
  }
  function renderHuman() {
    const searches = document.getElementById("search-human"); searches.replaceChildren();
    const providerBody = document.getElementById("providers-human"); providerBody.replaceChildren();
    const funnel = document.getElementById("funnel-human"); funnel.replaceChildren();
    const cards = document.getElementById("sources-human"); cards.replaceChildren();
    const reasons = document.getElementById("rejections-human"); reasons.replaceChildren(); const causeGroups = new Map();
    for (const [index, resolution] of data.resolutions.entries()) {
      if (searchFilter.value && resolution.id !== searchFilter.value) continue;
      const search = dict.searchLabel + " " + (index + 1);
      const context = privateContexts.find(c => c.resolutionId === resolution.id);
      const requested = resolution.events.find(e => e.kind === "REQUEST");
      const article = document.createElement("article"); searches.appendChild(article);
      const episodeContext = context && context.mediaKind === "episode" && Object.prototype.hasOwnProperty.call(context, "seriesTitle");
      text(article, "h3", search + ": " + (context ? episodeContext ? dict.seriesTitle + ": " + (context.seriesTitle || dict.contentMissing) : context.title || dict.contentMissing : dict.contentHidden));
      if (episodeContext) text(article, "p", dict.episodeTitleUnavailable);
      text(article, "p", dict.mediaKind + ": " + label(context ? context.mediaKind : requested ? requested.mediaKind : "UNOBSERVED"));
      if (context && context.season !== null) text(article, "p", dict.season + ": " + context.season + (context.episode !== null ? "; " + dict.episode + ": " + context.episode : ""));
      const states = resolution.events.filter(e => e.kind === "PROVIDER_STATE");
      const slots = [...new Set(states.map(e => e.provider))];
      text(providerBody, "h3", search);
      if (!slots.length) text(providerBody, "p", dict.noProviderEvidence);
      else {
        const table = document.createElement("table"); providerBody.appendChild(table);
        const head = document.createElement("thead"); table.appendChild(head);
        const hr = document.createElement("tr"); head.appendChild(hr);
        for (const key of ["providerLabel", "state", "failureCategory", "received", "delivered", "finalSurvivors"]) { const th = text(hr, "th", label(key)); th.setAttribute("scope", "col"); }
        const body = document.createElement("tbody"); table.appendChild(body);
        for (const slot of slots) {
          const events = states.filter(e => e.provider === slot);
          const latest = events.at(-1).status;
          const outcome = latest === "ENABLED" ? "NOT_OBSERVED" : latest;
          const failure = resolution.events.find(e => e.kind === "PROVIDER_FAILURE" && e.provider === slot);
          const category = outcome === "FAILED" || outcome === "TIMED_OUT"
            ? failure ? label(failure.category) : dict.failureNotCaptured : dict.failureNotApplicable;
          if (context && ["FAILED", "TIMED_OUT", "CANCELLED", "RETURNED_ZERO"].includes(outcome)) text(providerBody, "p", providerName(resolution.id, slot) + ": " + dict.noIndividualMetadata);
          const counts = resolution.events.find(e => e.kind === "PROVIDER_COUNTS" && e.provider === slot);
          const owned = [...candidates.values()].filter(c => c.resolutionId === resolution.id && evidence(c).source && evidence(c).source.provider === slot);
          const finalAvailable = resolution.events.some(e => e.kind === "SNAPSHOT" && e.stage === "FINAL");
          line(body, [providerName(resolution.id, slot), outcome === "FAILED" ? dict.providerFailed : outcome === "CANCELLED" ? dict.providerCancelled : label(outcome), category, counts ? counts.received : dict.UNOBSERVED, counts ? counts.delivered : dict.UNOBSERVED, finalAvailable ? owned.filter(c => evidence(c).final).length : dict.UNOBSERVED]);
        }
      }
      const flow = document.createElement("article"); funnel.appendChild(flow); text(flow, "h3", search);
      for (const stage of stages) {
        const snapshot = resolution.events.filter(e => (e.kind === "SNAPSHOT" || e.kind === "STAGE") && e.stage === stage).at(-1);
        const step = text(flow, "p", label(stage) + ": " + (snapshot ? snapshot.count : dict.UNOBSERVED));
        if (stage === "PROBED") {
          text(step, "small", dict.probedBoundaryNotice);
          const observations = resolution.events.filter(e => e.kind === "OBSERVATION" && e.stage === "PROBED");
          const complete = resolution.state === "CLOSED" && snapshot && snapshot.kind === "SNAPSHOT"
            && snapshot.count === snapshot.observed && observations.length === snapshot.count
            && new Set(observations.map(e => e.candidateId)).size === snapshot.count;
          if (complete) {
            const counts = new Map();
            for (const observation of observations) counts.set(observation.probe, (counts.get(observation.probe) || 0) + 1);
            text(step, "small", dict.probedStateBreakdown + ": " + ([...counts].map(([status, count]) => label(status) + ": " + count).join("; ") || "0"));
          } else text(step, "small", dict.probedBreakdownUnavailable);
        }
      }
      for (const c of candidates.values()) {
        if (c.resolutionId !== resolution.id) continue;
        const events = c.rows.map(r => r.event), details = events.filter(e => e.kind === "SOURCE").at(-1);

        const rejection = evidence(c).rejection;

        const unknownGap = evidence(c).gap && !evidence(c).final;
        if (rejection || unknownGap) {
          const groupKey = search + ": " + (rejection ? label(rejection.reason) + " (" + label(rejection.stage) + ")" : dict.unknownDisappearance);
          causeGroups.set(groupKey, (causeGroups.get(groupKey) || 0) + 1);
        }
        if (!sourceMatches(c)) continue;
        const tr = document.createElement("tr"); cards.appendChild(tr);
        const key = c.resolutionId + ":" + c.id;
        tr.setAttribute("data-key", key); tr.setAttribute("aria-selected", String(selectedKey === key));
        const first = document.createElement("th"); first.setAttribute("scope", "row"); tr.appendChild(first);
        const button = text(first, "button", sourceName(c) + " · " + (details ? label(details.transport) : dict.UNOBSERVED) + " · " + (details && details.height ? details.height + "p" : dict.qualityMissing));
        button.type = "button"; button.setAttribute("aria-label", dict.inspectSource + " " + sourceName(c));
        button.addEventListener("click", function () { selectSource(c); });
        text(first, "small", providerName(c.resolutionId, details && details.provider));
        const v = evidence(c);
        text(first, "small", v.final ? dict.selectedSource : rejection ? dict.explicitRejected + ": " + label(rejection.reason) : v.gap ? dict.unknownDisappearance : dict.observationUnavailable);
        for (const stage of stages) {
          const status = stageEvidence(c, stage), td = document.createElement("td"); tr.appendChild(td);
          td.setAttribute("class", status[0]);
          const b = text(td, "button", status[1]); b.type = "button";
          b.setAttribute("aria-label", sourceName(c) + " · " + label(stage) + ": " + status[2]);
          b.setAttribute("title", label(stage) + ": " + status[2]);
          b.addEventListener("click", function () { selectSource(c); });
          text(td, "small", status[2]);
        }
      }
    }
    for (const [cause, count] of causeGroups) text(reasons, "li", cause + ": " + count);
    if (!causeGroups.size) text(reasons, "li", dict.noExplicitRejections);
    const all = [...candidates.values()].filter(c => c.resolutionId === searchFilter.value);
    document.getElementById("source-counts").textContent = dict.globalCounts + ": " + all.length + " · " + dict.finalFilter + ": " + all.filter(c => evidence(c).final).length + " · " + dict.rejectedFilter + ": " + all.filter(c => evidence(c).rejection).length + " · " + dict.unknownFilter + ": " + all.filter(c => { const v = evidence(c); return v.gap && !v.final && !v.rejection; }).length + " · " + dict.visibleSources + ": " + cards.children.length;
    renderInspector();
  }
  function renderTables() {
    renderHuman();
    const funnel = document.getElementById("funnel-body"); funnel.replaceChildren();
    for (const resolution of data.resolutions) {
      if (searchFilter.value && resolution.id !== searchFilter.value) continue;
      for (const stage of stages) {
        const snapshots = resolution.events.filter(e => (e.kind === "SNAPSHOT" || e.kind === "STAGE") && e.stage === stage);
        const snapshot = snapshots[snapshots.length - 1];
        line(funnel, [resolution.id, code(stage), snapshot ? String(snapshot.count) : code("UNOBSERVED"), snapshot && snapshot.observed !== undefined ? String(snapshot.observed) : code("UNOBSERVED")]);
      }
    }
    const body = document.getElementById("candidates-body"); body.replaceChildren();
    for (const c of candidates.values()) {
      if (!c.rows.some(matches)) continue;
      const observations = c.rows.map(r => r.event).filter(e => e.identity !== undefined);
      const probes = c.rows.map(r => r.event).filter(e => e.probe !== undefined);
      const ranks = c.rows.map(r => r.event).filter(e => e.kind === "RANKING");
      const rank = ranks[ranks.length - 1];
      const tr = line(body, [c.resolutionId, "", observations.length ? code(observations[observations.length - 1].identity) : code("UNOBSERVED"),
        probes.length ? code(probes[probes.length - 1].probe) : code("UNOBSERVED"), rank ? String(rank.position) : code("UNOBSERVED"),
        ...scores.map(key => rank ? String(rank[key]) : code("UNOBSERVED"))]);
      const button = document.createElement("button"); button.type = "button"; button.textContent = c.id;
      button.setAttribute("aria-label", dict.candidateDetails + " " + c.id);
      button.addEventListener("click", function () { candidate.value = c.id; phase.value = ""; state.value = ""; renderTables(); document.getElementById("timeline-heading").focus(); });
      tr.children[1].appendChild(button);
    }
    const timeline = document.getElementById("timeline-body"); timeline.replaceChildren();
    let count = 0;
    for (const row of rows) {
      if (!matches(row)) continue;
      count++;
      const e = row.event;
      const details = eventDetails(e);
      line(timeline, [row.resolutionId, e.candidateId || code("UNOBSERVED"), code(e.stage || "UNOBSERVED"), code(e.kind), details]);
    }
    if (!count) line(timeline, [dict.empty]);
    const gaps = document.getElementById("gap-list"); gaps.replaceChildren();
    for (const row of rows) if (row.event.kind === "GAP" && (!searchFilter.value || row.resolutionId === searchFilter.value)) {
      const li = document.createElement("li");
      li.textContent = row.resolutionId + " / " + row.event.candidateId + ": " + code(row.event.stage) + "; " + code(row.event.context) + "; " + code(row.event.reason);
      gaps.appendChild(li);
    }
  }
  function render(lang) {
    if (lang !== "en" && lang !== "es") return;
    dict = dictionaries[lang]; document.documentElement.lang = lang; document.title = dict.title; language.value = lang;
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = label(node.getAttribute("data-i18n"));
    for (const node of document.querySelectorAll("[data-aria]")) node.setAttribute("aria-label", label(node.getAttribute("data-aria")));
    const summary = document.getElementById("summary-body"); summary.replaceChildren();
    for (const [field, v] of [["session", data.id], ["state", data.state], ["reason", data.reason], ["reserved", data.reserved],
      ["skippedConcurrent", data.skippedConcurrent], ["events", data.events], ["resolutions", data.resolutions.length]]) line(summary, [label(field), value(field, v)]);
    for (const resolution of data.resolutions) line(summary, [dict.resolutionId + ": " + resolution.id, code(resolution.state)]);
    const oldSearch = searchFilter.value; searchFilter.replaceChildren();
    for (const [index, resolution] of data.resolutions.entries()) {
      const context = privateContexts.find(c => c.resolutionId === resolution.id);
      option(searchFilter, resolution.id, dict.searchLabel + " " + (index + 1) + (context && (Object.prototype.hasOwnProperty.call(context, "seriesTitle") ? context.seriesTitle : context.title) ? " · " + (Object.prototype.hasOwnProperty.call(context, "seriesTitle") ? context.seriesTitle : context.title) : ""));
    }
    searchFilter.value = data.resolutions.some(r => r.id === oldSearch) ? oldSearch : data.resolutions[0] ? data.resolutions[0].id : "";
    const limitBody = document.getElementById("limits-body"); limitBody.replaceChildren();
    for (const [key, v] of Object.entries(limits)) line(limitBody, [label(key), String(v)]);
    fillSelect(phase, [...stages, "UNOBSERVED"], false);
    fillSelect(state, [...new Set(rows.flatMap(rowStates))].sort(), false);
    fillSelect(candidate, [...new Set(rows.filter(r => !searchFilter.value || r.resolutionId === searchFilter.value).map(r => r.event.candidateId).filter(Boolean))], true);
    const oldProvider = providerFilter.value; providerFilter.replaceChildren(); option(providerFilter, "", dict.all);
    const selectedResolution = data.resolutions.find(r => r.id === searchFilter.value);
    const providers = selectedResolution ? [...new Set(selectedResolution.events.filter(e => e.kind === "PROVIDER_STATE" || e.kind === "SOURCE").map(e => e.provider))] : [];
    for (const slot of providers) option(providerFilter, String(slot), providerName(searchFilter.value, slot));
    providerFilter.value = providers.map(String).includes(oldProvider) ? oldProvider : "";
    const oldOutcome = outcomeFilter.value; outcomeFilter.replaceChildren();
    for (const [key, title] of [["", "allSources"], ["final", "finalFilter"], ["rejected", "rejectedFilter"], ["unknown", "unknownFilter"]]) option(outcomeFilter, key, label(title));
    outcomeFilter.value = oldOutcome;
    renderTables();
  }
  language.addEventListener("change", function () { render(language.value); });
  searchFilter.addEventListener("change", function () { phase.value = ""; state.value = ""; candidate.value = ""; providerFilter.value = ""; outcomeFilter.value = ""; selectedKey = ""; render(language.value); });
  for (const select of [phase, state, candidate, providerFilter, outcomeFilter]) select.addEventListener("change", renderTables);
  render("en");
})();`;

const css = `:root{color-scheme:dark;--bg:#171c1e;--panel:#202729;--line:#3c494b;--text:#e2e9e7;--muted:#aebdba;--good:#8ed3c2;--amber:#edc479;--red:#ffaca7}*{box-sizing:border-box}body{font:14px system-ui,sans-serif;color:var(--text);background:var(--bg);margin:0}main{max-width:1660px;margin:auto;padding:20px 28px}header{display:flex;align-items:center;gap:20px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding:8px 0 16px}.eyebrow{font:11px ui-monospace,monospace;color:var(--good);letter-spacing:1px}h1{font-size:24px;letter-spacing:-.6px;margin:0 auto 0 0}h2{font-size:15px;margin:0 0 12px}h3{font-size:15px;margin:8px 0}p{line-height:1.5;margin:8px 0;color:var(--muted)}section{border-top:1px solid var(--line);padding:16px 0;margin:12px 0}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;vertical-align:top;padding:10px 8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}thead th{color:var(--muted);font:11px ui-monospace,monospace;background:var(--panel);position:sticky;top:0}button,select{font:inherit;color:inherit;background:#283335;border:1px solid #607370;border-radius:3px;padding:7px;max-width:100%}button,summary{cursor:pointer}button:hover{background:#344744}label{display:inline-block;margin:6px 14px 6px 0;font-size:12px}label span{display:block;margin-bottom:5px;color:var(--muted)}.scroll{overflow:auto;min-width:0}.notice{border-left:3px solid var(--amber);padding:4px 12px;background:#27271f;margin:12px 0;font-size:12px}.notice p{color:#e1cfaa}small{display:block;font-size:11px;font-weight:400;color:var(--muted);margin-top:5px;line-height:1.4}.flow article{display:flex;gap:0;flex-wrap:wrap;align-items:stretch}.flow h3{display:none}.flow p{border-left:2px solid #508f82;padding:8px 16px;margin:0;font:12px ui-monospace,monospace;background:var(--panel);flex:1}.workbench{display:grid;grid-template-columns:minmax(0,1fr) 300px;border:1px solid var(--line);background:var(--panel)}#source-inspector{padding:18px;border-left:1px solid var(--line);min-width:0;overflow-wrap:anywhere}#source-inspector h2{font-size:20px}#source-inspector strong{display:block;line-height:1.5}#source-inspector details{font:11px ui-monospace,monospace}.matrix{min-width:840px}.matrix th:first-child{width:220px}.matrix td{min-width:86px;text-align:center}.matrix td button{font:20px ui-monospace,monospace;border:0;background:transparent;padding:0 10px}.matrix td small{font-size:10px;max-width:120px}.matrix .observed button{color:var(--good)}.matrix .rejected button{color:var(--red)}.matrix .unknown button,.matrix .incomplete button{color:var(--amber)}.matrix .unavailable button{color:var(--muted)}.matrix tr[aria-selected=true]{background:#2b403d;box-shadow:inset 3px 0 var(--good)}.matrix th button{text-align:left;background:transparent;border:0;padding:0;font-size:12px;color:var(--text)}.legend{font:12px ui-monospace,monospace;color:var(--text)}#source-counts{font:12px ui-monospace,monospace;color:var(--good)}.toolbar h2{font-size:12px;color:var(--muted)}.search-context h3{font-size:20px}.search-context article{display:flex;align-items:baseline;gap:20px;flex-wrap:wrap}details{margin:12px 0}summary{padding:10px 0;font-weight:600}button:focus-visible,select:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #a9e8d8;outline-offset:3px}#inspector-heading:focus{outline:2px solid var(--good);outline-offset:4px}@media(max-width:1000px){.workbench{grid-template-columns:1fr}#source-inspector{border-left:0;border-top:1px solid var(--line)}}@media(max-width:600px){main{padding:12px}header{gap:10px}h1{font-size:22px}.flow p{flex:1 1 33%;padding:8px}.search-context article{gap:0}.toolbar label{display:block;margin-right:0}.toolbar select{width:100%}.matrix{min-width:760px}}`;
function hash(value: string): string { return createHash("sha256").update(value).digest("base64"); }

export function renderDiagnosticHtml(input: unknown): string {
  validateDiagnosticTranslations();
  const report = validateDiagnosticExport(input);
  const sequence = "privacy" in report ? report.report : report;
  const d = diagnosticTranslations.en;
  const label = (key: keyof DiagnosticDictionary, tag = "h2", extra = "") => `<${tag} data-i18n="${key}" ${extra}>${escapeDiagnosticHtml(d[key])}</${tag}>`;
  const headers = (keys: Array<keyof DiagnosticDictionary>) => `<thead><tr>${keys.map(key => label(key, "th", 'scope="col"')).join("")}</tr></thead>`;
  const table = (id: string, keys: Array<keyof DiagnosticDictionary>) => `<div class="scroll"><table>${headers(keys)}<tbody id="${id}"></tbody></table></div>`;
  const csp = `default-src 'none'; script-src 'sha256-${hash(diagnosticReportScript)}'; style-src 'sha256-${hash(css)}'; connect-src 'none'; img-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeDiagnosticHtml(csp)}"><title>${d.title}</title><style>${css}</style></head><body><main>
<header><span class="eyebrow">TRIBLER / STREMIO · DIAGNOSTICS</span>${label("title", "h1")}<label><span data-i18n="language">${d.language}</span> <select id="language" data-aria="language" aria-label="${d.language}"><option value="en" selected>English</option><option value="es">Español</option></select></label>
</header><noscript>${escapeDiagnosticHtml(d.noScript)}</noscript>
<aside class="notice">${label("privacy" in report ? "privateNotice" : "anonymousNotice", "p")}</aside>
<aside role="status">${label(sequence.state === "TRUNCATED" ? "globalIncomplete" : "captureClosed", "p")}</aside>
<label><span data-i18n="searchFilter">${d.searchFilter}</span><select id="resolution-filter" data-aria="searchFilter" aria-label="${d.searchFilter}"></select></label>
<section><div class="search-context" id="search-human"></div></section>
<section>${label("phaseCounts")}<div class="flow" id="funnel-human"></div></section>
<section class="toolbar">${label("filters")}<label><span data-i18n="outcomeFilter">${d.outcomeFilter}</span><select id="outcome-filter" data-aria="outcomeFilter"></select></label><label><span data-i18n="providerFilter">${d.providerFilter}</span><select id="provider-filter" data-aria="providerFilter"></select></label><label><span data-i18n="phaseFilter">${d.phaseFilter}</span><select id="phase" data-aria="phaseFilter" aria-label="${d.phaseFilter}"></select></label><label><span data-i18n="stateFilter">${d.stateFilter}</span><select id="state-filter" data-aria="stateFilter" aria-label="${d.stateFilter}"></select></label><label><span data-i18n="candidateFilter">${d.candidateFilter}</span><select id="candidate-filter" data-aria="candidateFilter" aria-label="${d.candidateFilter}"></select></label></section>
<section>${label("matrix")}<p id="source-counts" role="status" aria-live="polite"></p>${label("matrixHelp", "p")}<p class="legend">${label("matrixLegend", "span")}</p><div class="workbench"><div class="scroll"><table class="matrix">${headers(["sourceLabel", "PROVIDER", "NORMALIZED", "DEDUPLICATED", "PROBED", "ADMITTED", "FINAL"])}<tbody id="sources-human"></tbody></table></div><aside id="source-inspector" aria-label="${d.inspector}" data-aria="inspector"></aside></div></section><section>${label("providersSummary")}${label("internalLimitNotice", "p")}<div class="scroll" id="providers-human"></div></section>

<section>${label("observedReasons")}<ul id="rejections-human"></ul></section>
<details id="technical">${label("technicalDetails", "summary")}
<section>${label("summary")}${table("summary-body", ["kind", "details"])}</section>
<section>${label("limits")}${table("limits-body", ["kind", "count"])}</section>
<section>${label("funnel")}${label("funnelNotice", "p")}${table("funnel-body", ["resolutionId", "phase", "count", "observed"])}</section>
<section>${label("candidates")}${table("candidates-body", ["resolutionId", "candidateId", "identity", "probe", "position", "score", "availability", "resolution", "size", "codec", "metadata", "transport"])}</section>
<section>${label("timeline", "h2", 'id="timeline-heading" tabindex="-1"')}${table("timeline-body", ["resolutionId", "candidateId", "phase", "kind", "details"])}</section>
<section class="notice">${label("gaps")}<ul id="gap-list"></ul></section></details>
<section class="notice">${label("gaps")}${label("unknownCauseNotice", "p")}${label("identityNotice", "p")}${label("limitation", "p")}${label("rankingNotice", "p")}${label("offline", "p")}${label("publishNotice", "p")}</section>
<script id="diagnostic-data" type="application/json">${embedDiagnosticJson(report)}</script>
<script id="diagnostic-translations" type="application/json">${embedDiagnosticJson(diagnosticTranslations)}</script>
<script id="diagnostic-limits" type="application/json">${embedDiagnosticJson(DIAGNOSTIC_LIMITS)}</script>
<script>${diagnosticReportScript}</script></main></body></html>`;
  if (Buffer.byteLength(html) > HTML_REPORT_MAX_BYTES) throw new DiagnosticCliError("OUTPUT_TOO_LARGE", 5);
  return html;
}
