import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth
} from 'firebase/auth';
import {
  clearIndexedDbPersistence,
  collection,
  doc,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  setDoc,
  terminate,
  type Unsubscribe
} from 'firebase/firestore';
import { authConfig, emailToUsername, normalizeUsername, usernameToEmail } from '../config/auth.config';
import { firebaseConfig } from '../config/firebase.config';
import { moveConfig } from '../config/move.config';
import type {
  AuthenticatedMoveUser,
  FirebaseRuntimeStatus,
  InventoryBundle,
  MoveEvent,
  RoomOption,
  SharedDestinationCatalogSnapshot
} from '../types';
import { getAllEvents, putEvents } from './db';
import { getEventsRevision, getInventoryRevision, sameRuntimeStatus } from './sync-stability';

interface SyncCallbacks {
  onEvents: (events: MoveEvent[]) => void | Promise<void>;
  onInventory: (inventory: InventoryBundle) => void | Promise<void>;
  onAuthorizedUser: (user: AuthenticatedMoveUser) => void | Promise<void>;
  onDestinationCatalog: (snapshot: SharedDestinationCatalogSnapshot) => void | Promise<void>;
  onStatus: (status: FirebaseRuntimeStatus) => void;
}

export class FirebaseSync {
  private status: FirebaseRuntimeStatus = {
    enabled: firebaseConfig.enabled,
    authReady: false,
    authenticated: false,
    authorized: false,
    connected: navigator.onLine,
    snapshotLoaded: false,
    inventoryLoaded: false
  };

  private auth: Auth | undefined;
  private db: ReturnType<typeof initializeFirestore> | undefined;
  private callbacks: SyncCallbacks;
  private currentUser: AuthenticatedMoveUser | undefined;
  private activeDataUid: string | undefined;
  private unsubscribeMember: Unsubscribe | undefined;
  private unsubscribeInventory: Unsubscribe | undefined;
  private unsubscribeEvents: Unsubscribe | undefined;
  private unsubscribeDestinations: Unsubscribe | undefined;
  private cloudEventIds = new Set<string>();
  private eventSnapshotReady = false;
  private flushInProgress = false;
  private flushRequested = false;
  private eventDeliveryTimer: number | undefined;
  private lastDeliveredEventRevision = '';
  private lastInventoryRevision = '';
  private lastAuthorizedRevision = '';
  private lastDestinationCatalogRevision = '';

  constructor(callbacks: SyncCallbacks) {
    this.callbacks = callbacks;
    window.addEventListener('online', () => {
      this.patchStatus({ connected: true });
      if (this.status.authorized) void this.flushLocalEvents();
    });
    window.addEventListener('offline', () => this.patchStatus({ connected: false }));
  }

  async start(): Promise<void> {
    this.emitStatus();
    if (!firebaseConfig.enabled) {
      this.patchStatus({ authReady: true });
      return;
    }

    try {
      const app = initializeApp({
        apiKey: firebaseConfig.apiKey,
        authDomain: firebaseConfig.authDomain,
        projectId: firebaseConfig.projectId,
        storageBucket: firebaseConfig.storageBucket,
        messagingSenderId: firebaseConfig.messagingSenderId,
        appId: firebaseConfig.appId
      });

      this.db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
      });
      this.auth = getAuth(app);
      await setPersistence(this.auth, browserLocalPersistence);

      onAuthStateChanged(
        this.auth,
        (user) => {
          this.patchStatus({ authReady: true, lastError: undefined });
          this.stopDataListeners();
          this.unsubscribeMember?.();
          this.unsubscribeMember = undefined;

          if (!user) {
            this.currentUser = undefined;
            this.patchStatus({
              authenticated: false,
              authorized: false,
              snapshotLoaded: false,
              inventoryLoaded: false,
              user: undefined
            });
            return;
          }

          const signedInUser: AuthenticatedMoveUser = {
            uid: user.uid,
            username: emailToUsername(user.email),
            displayName: user.displayName ?? undefined,
            email: user.email ?? undefined
          };
          this.currentUser = signedInUser;
          this.patchStatus({
            authenticated: true,
            authorized: false,
            snapshotLoaded: false,
            inventoryLoaded: false,
            user: signedInUser
          });
          this.watchMembership(signedInUser);
        },
        () => this.patchStatus({
          authReady: true,
          authenticated: false,
          authorized: false,
          lastError: 'Unable to restore the saved sign-in on this device.'
        })
      );
    } catch (error) {
      this.patchStatus({
        authReady: true,
        lastError: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async signIn(username: string, password: string, rememberDevice: boolean = authConfig.defaultRememberDevice): Promise<void> {
    if (!this.auth || !firebaseConfig.enabled) throw new Error('Firebase Authentication is not configured yet.');
    const normalized = normalizeUsername(username);
    if (!normalized || !password) throw new Error('Enter both the username and password.');

    try {
      this.patchStatus({ lastError: undefined });
      await setPersistence(this.auth, rememberDevice ? browserLocalPersistence : browserSessionPersistence);
      await signInWithEmailAndPassword(this.auth, usernameToEmail(normalized), password);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      const message = code === 'auth/network-request-failed'
        ? 'The first sign-in requires an internet connection. Reconnect and try again.'
        : code === 'auth/too-many-requests'
          ? 'Too many attempts were made. Wait a little while and try again.'
          : 'The username or password is incorrect.';
      this.patchStatus({ lastError: message });
      throw new Error(message);
    }
  }

  async signOut(): Promise<void> {
    if (!this.auth) return;
    await firebaseSignOut(this.auth);
  }

  async forgetDeviceData(): Promise<void> {
    this.stopDataListeners();
    this.unsubscribeMember?.();
    this.unsubscribeMember = undefined;
    if (this.auth) await firebaseSignOut(this.auth);
    if (this.db) {
      const firestore = this.db;
      await terminate(firestore);
      await clearIndexedDbPersistence(firestore);
      this.db = undefined;
    }
  }

  async publish(event: MoveEvent): Promise<void> {
    if (!this.db || !this.status.authorized || !this.currentUser) return;
    const prepared = this.prepareEvent(event);
    if (prepared !== event) await putEvents([prepared]);
    try {
      await setDoc(doc(this.db, 'moves', moveConfig.moveId, 'events', prepared.id), prepared);
    } catch (error) {
      this.patchStatus({ lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  async flushLocalEvents(): Promise<void> {
    if (!this.db || !this.status.authorized || !this.currentUser) return;
    if (!this.eventSnapshotReady) {
      this.flushRequested = true;
      return;
    }
    if (this.flushInProgress) {
      this.flushRequested = true;
      return;
    }

    this.flushInProgress = true;
    this.flushRequested = false;
    try {
      const events = await getAllEvents();
      // The UI already rendered these durable local events. Mark this revision as
      // delivered before upload so acknowledgements cannot trigger a redraw storm.
      this.lastDeliveredEventRevision = getEventsRevision(events);
      const missingEvents = events.filter((event) => !this.cloudEventIds.has(event.id));
      if (!missingEvents.length) return;

      const preparedEvents = missingEvents.map((event) => this.prepareEvent(event));
      await putEvents(preparedEvents);
      for (const event of preparedEvents) {
        try {
          await setDoc(doc(this.db, 'moves', moveConfig.moveId, 'events', event.id), event);
          this.cloudEventIds.add(event.id);
        } catch (error) {
          this.patchStatus({ lastError: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
    } finally {
      this.flushInProgress = false;
      if (this.flushRequested) {
        this.flushRequested = false;
        window.setTimeout(() => void this.flushLocalEvents(), 0);
      }
    }
  }

  async saveDestinationCatalog(catalog: RoomOption[]): Promise<void> {
    if (!this.db || !this.status.authorized || !this.currentUser) {
      throw new Error('The shared destination list cannot sync until this device is authorized.');
    }
    const snapshot: SharedDestinationCatalogSnapshot = {
      catalog: catalog.map((room) => ({
        code: room.code.trim().toUpperCase(),
        label: room.label.trim(),
        directions: room.directions?.trim() || undefined,
        active: room.active !== false
      })),
      updatedAt: Date.now(),
      updatedByUid: this.currentUser.uid,
      updatedByUsername: this.currentUser.username
    };
    await setDoc(doc(this.db, 'moves', moveConfig.moveId, 'shared', 'destinations'), {
      catalogJson: JSON.stringify(snapshot.catalog),
      updatedAt: snapshot.updatedAt,
      updatedByUid: snapshot.updatedByUid,
      updatedByUsername: snapshot.updatedByUsername
    });
  }

  getStatus(): FirebaseRuntimeStatus {
    return { ...this.status };
  }

  getCurrentUser(): AuthenticatedMoveUser | undefined {
    return this.currentUser ? { ...this.currentUser } : undefined;
  }

  private watchMembership(user: AuthenticatedMoveUser): void {
    if (!this.db) return;
    const memberRef = doc(this.db, 'moves', moveConfig.moveId, 'members', user.uid);
    this.unsubscribeMember = onSnapshot(
      memberRef,
      (snapshot) => {
        const data = snapshot.data() as { active?: boolean; username?: string; displayName?: string } | undefined;
        if (!snapshot.exists() || data?.active !== true) {
          this.stopDataListeners();
          this.patchStatus({
            authorized: false,
            lastError: navigator.onLine ? 'This account is not authorized for this move.' : undefined
          });
          return;
        }

        const authorizedUser: AuthenticatedMoveUser = {
          ...user,
          username: data.username || user.username,
          displayName: data.displayName || user.displayName
        };
        this.currentUser = authorizedUser;
        this.patchStatus({ authorized: true, user: authorizedUser, lastError: undefined });
        const authorizedRevision = `${authorizedUser.uid}|${authorizedUser.username}|${authorizedUser.displayName ?? ''}`;
        if (authorizedRevision !== this.lastAuthorizedRevision) {
          this.lastAuthorizedRevision = authorizedRevision;
          void this.callbacks.onAuthorizedUser(authorizedUser);
        }
        this.startDataListeners(authorizedUser.uid);
      },
      (error) => {
        this.patchStatus({
          authorized: false,
          lastError: navigator.onLine
            ? (error.code === 'permission-denied' ? 'This account is not authorized for this move.' : 'The secure access check failed. Try again.')
            : undefined
        });
      }
    );
  }

  private startDataListeners(uid: string): void {
    if (!this.db || this.activeDataUid === uid) return;
    this.stopDataListeners();
    this.activeDataUid = uid;

    const inventoryRef = doc(this.db, 'moves', moveConfig.moveId, 'private', 'inventory');
    this.unsubscribeInventory = onSnapshot(
      inventoryRef,
      async (snapshot) => {
        if (!snapshot.exists()) {
          this.patchStatus({
            inventoryLoaded: false,
            lastError: navigator.onLine ? 'The secure inventory has not been uploaded to Firebase yet.' : undefined
          });
          return;
        }
        const secureInventory = snapshot.data() as InventoryBundle;
        const revision = getInventoryRevision(secureInventory);
        if (revision !== this.lastInventoryRevision) {
          this.lastInventoryRevision = revision;
          await this.callbacks.onInventory(secureInventory);
        }
        this.patchStatus({ inventoryLoaded: true, connected: navigator.onLine, lastError: undefined });
      },
      (error) => this.patchStatus({ lastError: error.message })
    );

    const destinationsRef = doc(this.db, 'moves', moveConfig.moveId, 'shared', 'destinations');
    this.unsubscribeDestinations = onSnapshot(
      destinationsRef,
      async (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data() as {
          catalogJson?: string;
          updatedAt?: number;
          updatedByUid?: string;
          updatedByUsername?: string;
        };
        if (!data.catalogJson) return;
        let catalog: RoomOption[];
        try {
          const parsed = JSON.parse(data.catalogJson) as unknown;
          if (!Array.isArray(parsed)) return;
          catalog = parsed
            .filter((entry): entry is RoomOption => Boolean(entry && typeof entry === 'object'))
            .map((entry) => ({
              code: String(entry.code ?? '').trim().toUpperCase(),
              label: String(entry.label ?? '').trim(),
              directions: entry.directions ? String(entry.directions).trim() : undefined,
              active: entry.active !== false
            }))
            .filter((entry) => Boolean(entry.code && entry.label));
        } catch {
          return;
        }
        const revision = `${data.updatedAt ?? 0}|${data.updatedByUid ?? ''}|${data.catalogJson}`;
        if (revision === this.lastDestinationCatalogRevision) return;
        this.lastDestinationCatalogRevision = revision;
        await this.callbacks.onDestinationCatalog({
          catalog,
          updatedAt: Number(data.updatedAt ?? 0),
          updatedByUid: String(data.updatedByUid ?? ''),
          updatedByUsername: String(data.updatedByUsername ?? '')
        });
      },
      (error) => this.patchStatus({ lastError: error.message })
    );

    const eventsQuery = query(collection(this.db, 'moves', moveConfig.moveId, 'events'));
    this.unsubscribeEvents = onSnapshot(
      eventsQuery,
      async (snapshot) => {
        const cloudEvents = snapshot.docs.map((snapshotDoc) => snapshotDoc.data() as MoveEvent);
        this.cloudEventIds = new Set(cloudEvents.map((event) => event.id));
        await putEvents(cloudEvents);
        this.scheduleEventDelivery();

        const serverSnapshot = !snapshot.metadata.fromCache;
        const firstServerSnapshot = serverSnapshot && !this.eventSnapshotReady;
        if (firstServerSnapshot) this.eventSnapshotReady = true;
        this.patchStatus({
          snapshotLoaded: this.status.snapshotLoaded || serverSnapshot,
          connected: navigator.onLine,
          lastError: undefined
        });
        if (firstServerSnapshot && navigator.onLine) void this.flushLocalEvents();
      },
      (error) => this.patchStatus({ lastError: error.message })
    );
  }

  private stopDataListeners(): void {
    this.unsubscribeInventory?.();
    this.unsubscribeEvents?.();
    this.unsubscribeDestinations?.();
    this.unsubscribeInventory = undefined;
    this.unsubscribeEvents = undefined;
    this.unsubscribeDestinations = undefined;
    this.activeDataUid = undefined;
    this.cloudEventIds.clear();
    this.eventSnapshotReady = false;
    this.flushRequested = false;
    window.clearTimeout(this.eventDeliveryTimer);
    this.eventDeliveryTimer = undefined;
    this.lastDeliveredEventRevision = '';
    this.lastInventoryRevision = '';
    this.lastDestinationCatalogRevision = '';
  }

  private scheduleEventDelivery(): void {
    window.clearTimeout(this.eventDeliveryTimer);
    this.eventDeliveryTimer = window.setTimeout(async () => {
      this.eventDeliveryTimer = undefined;
      const allEvents = await getAllEvents();
      const revision = getEventsRevision(allEvents);
      if (revision === this.lastDeliveredEventRevision) return;
      this.lastDeliveredEventRevision = revision;
      await this.callbacks.onEvents(allEvents);
    }, 180);
  }

  private prepareEvent(event: MoveEvent): MoveEvent {
    if (!this.currentUser) return event;
    if (event.actorUid === this.currentUser.uid && event.actorUsername === this.currentUser.username) return event;
    return {
      ...event,
      actorUid: this.currentUser.uid,
      actorUsername: this.currentUser.username
    };
  }

  private patchStatus(patch: Partial<FirebaseRuntimeStatus>): void {
    const nextStatus = { ...this.status, ...patch };
    if (sameRuntimeStatus(this.status, nextStatus)) return;
    this.status = nextStatus;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.callbacks.onStatus(this.getStatus());
  }
}

