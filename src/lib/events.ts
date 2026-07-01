import type { DerivedItemState, InventoryItem, MoveEvent, MoveSettings, RoomOption } from '../types';

export function deriveItemState(itemId: string, events: MoveEvent[]): DerivedItemState {
  const relevant = events
    .filter((event) => event.itemId === itemId)
    .sort(compareEvents);

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
    keepOriginalRoom: latestPlan?.payload.keepOriginalRoom === true,
    issueCount: issues.length,
    latestIssue: asOptionalString(latestIssue?.payload.note)
  };
}


export function deriveMoveSettings(events: MoveEvent[]): MoveSettings {
  const latest = events
    .filter((event) => event.type === 'SETTINGS_UPDATE' && event.itemId === 'MOVE-SETTINGS')
    .sort(compareEvents)
    .at(-1);

  return {
    hasCrateListing: latest?.payload.hasCrateListing === true,
    updatedAt: latest?.clientAt,
    updatedByUsername: latest?.actorUsername
  };
}

export function deriveDestinationCatalog(events: MoveEvent[], defaults: RoomOption[]): RoomOption[] {
  const latest = events
    .filter((event) => event.type === 'DESTINATIONS_UPDATE' && event.itemId === 'MOVE-DESTINATIONS')
    .sort(compareEvents)
    .at(-1);

  const catalogJson = asOptionalString(latest?.payload.catalogJson);
  if (!catalogJson) return sanitizeDestinationCatalog(defaults, defaults);

  try {
    const parsed = JSON.parse(catalogJson) as unknown;
    return sanitizeDestinationCatalog(parsed, defaults);
  } catch {
    return sanitizeDestinationCatalog(defaults, defaults);
  }
}

function sanitizeDestinationCatalog(value: unknown, fallback: RoomOption[]): RoomOption[] {
  if (!Array.isArray(value)) return fallback.map((room) => ({ ...room }));
  const catalog: RoomOption[] = [];
  const usedCodes = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const code = cleanString(record.code).toUpperCase().slice(0, 40);
    const label = cleanString(record.label).slice(0, 120);
    if (!code || !label || usedCodes.has(code)) continue;
    usedCodes.add(code);
    catalog.push({
      code,
      label,
      directions: cleanString(record.directions).slice(0, 240) || undefined,
      active: record.active !== false
    });
  }
  return catalog.length ? catalog : fallback.map((room) => ({ ...room }));
}

export function findActiveReceipt(itemId: string, events: MoveEvent[]): MoveEvent | undefined {
  const relevant = events
    .filter((event) => event.itemId === itemId)
    .sort(compareEvents);
  const voided = new Set(
    relevant
      .filter((event) => event.type === 'RECEIPT_VOID')
      .map((event) => String(event.payload.receiptId ?? ''))
  );
  return relevant
    .filter((event) => event.type === 'RECEIVED' && !voided.has(event.id))
    .at(-1);
}

export function deriveAdHocItems(events: MoveEvent[]): InventoryItem[] {
  const itemEvents = events
    .filter((event) => event.type === 'ITEM_ADD' || event.type === 'ITEM_EDIT' || event.type === 'ITEM_VOID')
    .sort(compareEvents);

  const snapshots = new Map<string, MoveEvent>();
  const additions = new Map<string, MoveEvent>();
  const voided = new Set<string>();

  for (const event of itemEvents) {
    if (event.type === 'ITEM_ADD' && !additions.has(event.itemId)) additions.set(event.itemId, event);
    if (event.type === 'ITEM_VOID') {
      voided.add(event.itemId);
      continue;
    }
    if (event.type === 'ITEM_ADD' || additions.has(event.itemId)) snapshots.set(event.itemId, event);
  }

  return [...snapshots.entries()]
    .filter(([itemId]) => !voided.has(itemId))
    .map(([itemId, event], index) => {
      const addition = additions.get(itemId) ?? event;
      const description = cleanString(event.payload.description) || 'Unexpected move item';
      const comments = cleanString(event.payload.comments);
      const packType = cleanString(event.payload.packType) || 'Unspecified package';
      const observedArea = cleanString(event.payload.observedArea) || 'Move-day addition';
      const assignedCrateId = cleanString(event.payload.assignedCrateId) || 'UNASSIGNED';
      const eventTags = Array.isArray(event.payload.tags)
        ? event.payload.tags.map((value) => cleanString(value)).filter(Boolean)
        : [];
      const tags = uniqueStrings([
        'extra',
        'unexpected item',
        'emergency add',
        itemId,
        description,
        comments,
        packType,
        observedArea,
        ...eventTags
      ]);

      return {
        itemId,
        crateId: assignedCrateId,
        sequence: 10_000 + index,
        description: comments ? `${description} - ${comments}` : description,
        originalRoom: observedArea,
        originalCode: packType,
        quantity: 1,
        rawLine: `Move-day extra | ${description}${comments ? ` | ${comments}` : ''} | ${packType} | ${observedArea}`,
        sourceRow: 'Emergency move-day addition',
        sourceFields: {
          'Inventory ID': itemId,
          Content: description,
          Comments: comments,
          'Pack Type': packType,
          'Original Room': observedArea,
          Packer: 'Move-day addition',
          'High Value': false,
          'Source Document': 'Added during delivery'
        },
        tags,
        isAdHoc: true,
        createdAt: addition.clientAt,
        createdBy: addition.actorUsername || addition.deviceName
      } satisfies InventoryItem;
    })
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.itemId.localeCompare(b.itemId));
}

export function findUndoableReceipt(itemId: string, events: MoveEvent[], maxAgeMs = 15_000): MoveEvent | undefined {
  const active = findActiveReceipt(itemId, events);
  if (!active || Date.now() - active.clientAt > maxAgeMs) return undefined;
  return active;
}

export function latestItemDetailEvent(itemId: string, events: MoveEvent[]): MoveEvent | undefined {
  return events
    .filter((event) => event.itemId === itemId && (event.type === 'ITEM_ADD' || event.type === 'ITEM_EDIT'))
    .sort(compareEvents)
    .at(-1);
}

function compareEvents(a: MoveEvent, b: MoveEvent): number {
  return a.clientAt - b.clientAt || a.id.localeCompare(b.id);
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
