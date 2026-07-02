import type { FirebaseRuntimeStatus, InventoryBundle, MoveEvent } from '../types';

export interface InteractionState {
  mode: 'live' | 'planning' | 'readiness';
  bulkPlannerOpen: boolean;
  openBulkPanelPresent: boolean;
  settingsOpen: boolean;
  emergencyModalOpen: boolean;
  activeTagName?: string;
  activeInsideEditor: boolean;
}

export function getEventsRevision(events: MoveEvent[]): string {
  return events
    .map((event) => `${event.id}:${event.clientAt}:${event.type}`)
    .sort()
    .join('|');
}

export function getInventoryRevision(inventory: InventoryBundle): string {
  return `${inventory.metadata.version}|${inventory.metadata.generatedAt}|${inventory.items.length}`;
}

export function getCloudUiRevision(status: FirebaseRuntimeStatus): string {
  return [
    status.enabled,
    status.authReady,
    status.authenticated,
    status.authorized,
    status.connected,
    status.snapshotLoaded,
    status.inventoryLoaded,
    status.user?.uid ?? '',
    status.user?.username ?? '',
    status.lastError ?? ''
  ].join('|');
}

export function sameRuntimeStatus(left: FirebaseRuntimeStatus, right: FirebaseRuntimeStatus): boolean {
  return left.enabled === right.enabled &&
    left.authReady === right.authReady &&
    left.authenticated === right.authenticated &&
    left.authorized === right.authorized &&
    left.connected === right.connected &&
    left.snapshotLoaded === right.snapshotLoaded &&
    left.inventoryLoaded === right.inventoryLoaded &&
    left.user?.uid === right.user?.uid &&
    left.user?.username === right.user?.username &&
    left.user?.displayName === right.user?.displayName &&
    left.user?.email === right.user?.email &&
    left.lastError === right.lastError;
}

export function shouldDeferForInteraction(state: InteractionState): boolean {
  if (state.mode === 'readiness') return false;
  if (state.settingsOpen || state.emergencyModalOpen) return true;
  if (state.bulkPlannerOpen || state.openBulkPanelPresent) return true;
  const tag = state.activeTagName?.toUpperCase();
  return state.activeInsideEditor || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}
