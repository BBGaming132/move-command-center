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
  MoveEvent
} from '../types';
import { getAllEvents, putEvents } from './db';

interface SyncCallbacks {
  onEvents: (events: MoveEvent[]) => void | Promise<void>;
  onInventory: (inventory: InventoryBundle) => void | Promise<void>;
  onAuthorizedUser: (user: AuthenticatedMoveUser) => void | Promise<void>;
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
    const events = await getAllEvents();
    const preparedEvents = events.map((event) => this.prepareEvent(event));
    await putEvents(preparedEvents);
    for (const event of preparedEvents) {
      try {
        await setDoc(doc(this.db, 'moves', moveConfig.moveId, 'events', event.id), event);
      } catch (error) {
        this.patchStatus({ lastError: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
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
      { includeMetadataChanges: true },
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
        void this.callbacks.onAuthorizedUser(authorizedUser);
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
      { includeMetadataChanges: true },
      async (snapshot) => {
        if (!snapshot.exists()) {
          this.patchStatus({
            inventoryLoaded: false,
            lastError: navigator.onLine ? 'The secure inventory has not been uploaded to Firebase yet.' : undefined
          });
          return;
        }
        const secureInventory = snapshot.data() as InventoryBundle;
        await this.callbacks.onInventory(secureInventory);
        this.patchStatus({ inventoryLoaded: true, connected: navigator.onLine, lastError: undefined });
      },
      (error) => this.patchStatus({ lastError: error.message })
    );

    const eventsQuery = query(collection(this.db, 'moves', moveConfig.moveId, 'events'));
    this.unsubscribeEvents = onSnapshot(
      eventsQuery,
      { includeMetadataChanges: true },
      async (snapshot) => {
        const cloudEvents = snapshot.docs.map((snapshotDoc) => snapshotDoc.data() as MoveEvent);
        await putEvents(cloudEvents);
        await this.callbacks.onEvents(cloudEvents);
        this.patchStatus({
          snapshotLoaded: this.status.snapshotLoaded || !snapshot.metadata.fromCache,
          connected: navigator.onLine,
          lastError: undefined
        });
      },
      (error) => this.patchStatus({ lastError: error.message })
    );

    void this.flushLocalEvents();
  }

  private stopDataListeners(): void {
    this.unsubscribeInventory?.();
    this.unsubscribeEvents?.();
    this.unsubscribeInventory = undefined;
    this.unsubscribeEvents = undefined;
    this.activeDataUid = undefined;
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
    this.status = { ...this.status, ...patch };
    this.emitStatus();
  }

  private emitStatus(): void {
    this.callbacks.onStatus(this.getStatus());
  }
}
