import type { DerivedItemState, InventoryItem } from '../types';

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function createSearchText(item: InventoryItem, state: DerivedItemState): string {
  const sourceValues = Object.entries(item.sourceFields)
    .flatMap(([key, value]) => [key, value])
    .join(' ');

  return normalize(
    [
      item.itemId,
      `item ${item.itemId}`,
      `piece ${item.itemId}`,
      item.crateId,
      state.assignedCrateId,
      item.sequence,
      item.description,
      item.originalRoom,
      item.originalCode,
      item.quantity,
      item.rawLine,
      item.sourcePage,
      item.sourceRow,
      item.tags.join(' '),
      sourceValues,
      state.destinationCode,
      state.destinationLabel,
      state.notes,
      state.latestIssue
    ].join(' ')
  );
}

export function matchesSearch(searchText: string, query: string): boolean {
  const tokens = normalize(query).split(' ').filter(Boolean);
  return tokens.every((token) => searchText.includes(token));
}
