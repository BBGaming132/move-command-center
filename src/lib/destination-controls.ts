import type { InventoryItem, RoomOption } from '../types';

export function normalizeDestinationCode(value: string): string {
  return value.trim().toUpperCase();
}

export function destinationLabelForCode(catalog: RoomOption[], code: string): string {
  const normalized = normalizeDestinationCode(code);
  if (!normalized) return '';
  return catalog.find((room) => normalizeDestinationCode(room.code) === normalized)?.label ?? '';
}

export function destinationOptions(
  catalog: RoomOption[],
  currentCode = '',
  currentLabel = ''
): RoomOption[] {
  const normalizedCurrent = normalizeDestinationCode(currentCode);
  const active = catalog
    .filter((room) => room.active)
    .map((room) => ({ ...room, code: normalizeDestinationCode(room.code) }));
  if (normalizedCurrent && !active.some((room) => room.code === normalizedCurrent)) {
    active.push({ code: normalizedCurrent, label: currentLabel.trim() || 'Previously assigned destination', active: true });
  }
  return active;
}

export function nextSequentialExtraItemId(items: InventoryItem[], minimum = 389): string {
  const numericIds = items
    .map((item) => Number(item.itemId))
    .filter((value) => Number.isInteger(value) && value > 0);
  const highest = numericIds.length ? Math.max(...numericIds) : minimum - 1;
  return String(Math.max(minimum, highest + 1));
}

export function isValidSequentialExtraItemId(value: string, minimum = 389): boolean {
  if (!/^\d{3,6}$/.test(value.trim())) return false;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= 999999;
}
