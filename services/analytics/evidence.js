const MAX_EVIDENCE_IDS = 200;
/** Evidence = the events behind a number (PDF: every insight links to source events). Capped, with the true count kept. */
export function evidenceOf(events, extra = {}) {
  const sorted = [...events].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  return { eventIds: sorted.slice(0, MAX_EVIDENCE_IDS).map((e) => e.id), totalEvents: events.length, ...extra };
}
