import type { DerivedItemState, MoveEvent } from '../types';

export function deriveItemState(itemId: string, events: MoveEvent[]): DerivedItemState {
  const relevant = events
    .filter((event) => event.itemId === itemId)
    .sort((a, b) => a.clientAt - b.clientAt || a.id.localeCompare(b.id));

  const voidedReceipts = new Set<string>();
  for (const event of relevant) {
    if (event.type === 'RECEIPT_VOID') {
      const receiptId = String(event.payload.receiptId ?? '');
      if (receiptId) voidedReceipts.add(receiptId);
    }
  }

  const receipts = relevant.filter(
    (event) => event.type === 'RECEIVED' && !voidedReceipts.has(event.id)
  );
  const latestReceipt = receipts.at(-1);
  const latestPlan = relevant.filter((event) => event.type === 'PLAN_UPDATE').at(-1);
  const issues = relevant.filter((event) => event.type === 'ISSUE');
  const latestIssue = issues.at(-1);

  return {
    received: receipts.length > 0,
    receivedAt: latestReceipt?.clientAt,
    receivedBy: latestReceipt?.deviceName,
    receivedByUsername: latestReceipt?.actorUsername,
    assignedCrateId: asOptionalString(latestPlan?.payload.assignedCrateId),
    destinationCode: asOptionalString(latestPlan?.payload.destinationCode),
    destinationLabel: asOptionalString(latestPlan?.payload.destinationLabel),
    notes: asOptionalString(latestPlan?.payload.notes),
    planningUpdatedAt: latestPlan?.clientAt,
    issueCount: issues.length,
    latestIssue: asOptionalString(latestIssue?.payload.note)
  };
}

export function findUndoableReceipt(itemId: string, events: MoveEvent[], maxAgeMs = 15_000): MoveEvent | undefined {
  const now = Date.now();
  const voided = new Set(
    events
      .filter((event) => event.itemId === itemId && event.type === 'RECEIPT_VOID')
      .map((event) => String(event.payload.receiptId ?? ''))
  );
  return events
    .filter(
      (event) =>
        event.itemId === itemId &&
        event.type === 'RECEIVED' &&
        !voided.has(event.id) &&
        now - event.clientAt <= maxAgeMs
    )
    .sort((a, b) => b.clientAt - a.clientAt)[0];
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
