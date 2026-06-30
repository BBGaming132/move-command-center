import type { AppMeta, InventoryBundle, MoveEvent } from '../types';

const DB_NAME = 'move-command-center-v1';
const DB_VERSION = 2;
const EVENT_STORE = 'events';
const META_STORE = 'meta';
const INVENTORY_STORE = 'inventory';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        const events = db.createObjectStore(EVENT_STORE, { keyPath: 'id' });
        events.createIndex('itemId', 'itemId', { unique: false });
        events.createIndex('clientAt', 'clientAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(INVENTORY_STORE)) {
        db.createObjectStore(INVENTORY_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local database.'));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Local database transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Local database transaction was aborted.'));
  });
}

export async function putEvent(event: MoveEvent): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(EVENT_STORE, 'readwrite');
  tx.objectStore(EVENT_STORE).put(event);
  await waitForTransaction(tx);
  db.close();
}

export async function putEvents(events: MoveEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(EVENT_STORE, 'readwrite');
  const store = tx.objectStore(EVENT_STORE);
  for (const event of events) store.put(event);
  await waitForTransaction(tx);
  db.close();
}

export async function deleteEvent(eventId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(EVENT_STORE, 'readwrite');
  tx.objectStore(EVENT_STORE).delete(eventId);
  await waitForTransaction(tx);
  db.close();
}

export async function getAllEvents(): Promise<MoveEvent[]> {
  const db = await openDb();
  const tx = db.transaction(EVENT_STORE, 'readonly');
  const request = tx.objectStore(EVENT_STORE).getAll();
  const result = await new Promise<MoveEvent[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as MoveEvent[]);
    request.onerror = () => reject(request.error ?? new Error('Unable to read local events.'));
  });
  await waitForTransaction(tx);
  db.close();
  return result;
}

export async function getMeta(): Promise<AppMeta | undefined> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readonly');
  const request = tx.objectStore(META_STORE).get('app');
  const result = await new Promise<{ key: string; value: AppMeta } | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as { key: string; value: AppMeta } | undefined);
    request.onerror = () => reject(request.error ?? new Error('Unable to read local settings.'));
  });
  await waitForTransaction(tx);
  db.close();
  return result?.value;
}

export async function putMeta(meta: AppMeta): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put({ key: 'app', value: meta });
  await waitForTransaction(tx);
  db.close();
}

export async function getCachedInventory(): Promise<InventoryBundle | undefined> {
  const db = await openDb();
  const tx = db.transaction(INVENTORY_STORE, 'readonly');
  const request = tx.objectStore(INVENTORY_STORE).get('master');
  const result = await new Promise<{ key: string; value: InventoryBundle } | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as { key: string; value: InventoryBundle } | undefined);
    request.onerror = () => reject(request.error ?? new Error('Unable to read the secure cached inventory.'));
  });
  await waitForTransaction(tx);
  db.close();
  return result?.value;
}

export async function putCachedInventory(inventory: InventoryBundle): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(INVENTORY_STORE, 'readwrite');
  tx.objectStore(INVENTORY_STORE).put({ key: 'master', value: inventory });
  await waitForTransaction(tx);
  db.close();
}

export async function clearLocalData(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([EVENT_STORE, META_STORE, INVENTORY_STORE], 'readwrite');
  tx.objectStore(EVENT_STORE).clear();
  tx.objectStore(META_STORE).clear();
  tx.objectStore(INVENTORY_STORE).clear();
  await waitForTransaction(tx);
  db.close();
}

export async function verifyLocalDatabase(): Promise<boolean> {
  try {
    const existing = await getMeta();
    if (!existing) {
      await putMeta({ deviceId: crypto.randomUUID(), deviceName: 'Unassigned device' });
    }
    return true;
  } catch {
    return false;
  }
}
