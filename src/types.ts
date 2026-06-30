export type EventType = 'RECEIVED' | 'PLAN_UPDATE' | 'ISSUE' | 'RECEIPT_VOID';

export interface InventoryMetadata {
  title: string;
  version: string;
  generatedAt: string;
  status: 'placeholder' | 'verified';
  expectedCrateCount: number;
  expectedItemCount?: number;
  originalStoragePalletCount?: number;
  crateMappingStatus?: 'provided' | 'not-provided-in-source';
  sourceDocuments: Array<{
    fileName: string;
    sha256?: string;
    pageCount?: number;
    role?: string;
  }>;
  referenceFacts?: Record<string, string | number | boolean | null>;
  unusableSourceDocuments?: Array<{
    fileName: string;
    reason: string;
  }>;
  notes?: string;
}

export interface CrateRecord {
  crateId: string;
  displayName: string;
  originalLabel?: string;
  sourcePages?: number[];
  notes?: string;
  isPhysical?: boolean;
}

export interface InventoryItem {
  itemId: string;
  crateId: string;
  sequence: number;
  description: string;
  originalRoom?: string;
  originalCode?: string;
  quantity?: number;
  rawLine: string;
  sourcePage?: number;
  sourceRow?: string;
  sourceFields: Record<string, string | number | boolean | null>;
  tags: string[];
}

export interface InventoryBundle {
  metadata: InventoryMetadata;
  crates: CrateRecord[];
  items: InventoryItem[];
}

export interface RoomOption {
  code: string;
  label: string;
  directions?: string;
  active: boolean;
}

export interface MoveEvent {
  id: string;
  moveId: string;
  type: EventType;
  itemId: string;
  deviceId: string;
  deviceName: string;
  actorUid?: string;
  actorUsername?: string;
  clientAt: number;
  payload: Record<string, unknown>;
}

export interface DerivedItemState {
  received: boolean;
  receivedAt?: number;
  receivedBy?: string;
  receivedByUsername?: string;
  assignedCrateId?: string;
  destinationCode?: string;
  destinationLabel?: string;
  notes?: string;
  planningUpdatedAt?: number;
  issueCount: number;
  latestIssue?: string;
}

export interface AppMeta {
  deviceId: string;
  deviceName: string;
  lastCloudSnapshotAt?: number;
  cloudReady?: boolean;
  lastAuthorizedUid?: string;
  lastAuthorizedUsername?: string;
}

export interface AuthenticatedMoveUser {
  uid: string;
  username: string;
  displayName?: string;
  email?: string;
}

export interface FirebaseRuntimeStatus {
  enabled: boolean;
  authReady: boolean;
  authenticated: boolean;
  authorized: boolean;
  connected: boolean;
  snapshotLoaded: boolean;
  inventoryLoaded: boolean;
  user?: AuthenticatedMoveUser;
  lastError?: string;
}
