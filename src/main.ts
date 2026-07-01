import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import roomJson from './data/rooms.json';
import { moveConfig } from './config/move.config';
import type {
  AppMeta,
  DerivedItemState,
  FirebaseRuntimeStatus,
  InventoryBundle,
  InventoryItem,
  MoveEvent,
  RoomOption
} from './types';
import {
  clearLocalData,
  getAllEvents,
  getCachedInventory,
  getMeta,
  putCachedInventory,
  putEvent,
  putEvents,
  putMeta,
  verifyLocalDatabase
} from './lib/db';
import {
  deriveAdHocItems,
  deriveDestinationCatalog,
  deriveItemState,
  deriveMoveSettings,
  findActiveReceipt,
  latestItemDetailEvent
} from './lib/events';
import { evaluateSearch, getGeneratedSearchTags, normalizeForSort, type SearchMatch } from './lib/search';
import { FirebaseSync } from './lib/firebase-sync';

const defaultRooms = roomJson as RoomOption[];
const appRoot = getAppRoot();

let inventory: InventoryBundle = emptyInventoryBundle();
let physicalCrates = inventory.crates.filter((crate) => crate.isPhysical !== false);
let inventoryCached = false;

type Mode = 'live' | 'planning' | 'readiness';
type StatusFilter =
  | 'all'
  | 'remaining'
  | 'received'
  | 'issues'
  | 'no-destination'
  | 'no-crate'
  | 'high-value'
  | 'extra';
type GroupBy = 'none' | 'room' | 'pack' | 'destination' | 'crate';
type SortBy = 'relevance' | 'item-asc' | 'item-desc' | 'room' | 'pack' | 'destination' | 'updated';

interface FilterState {
  originalRoom: string;
  packType: string;
  destination: string;
  crate: string;
  rangeFrom: string;
  rangeTo: string;
}

interface VisibleItem {
  item: InventoryItem;
  state: DerivedItemState;
  match: SearchMatch;
}

interface CountSummary {
  total: number;
  verified: number;
  extras: number;
  received: number;
  issues: number;
  destinationAssigned: number;
  crateAssigned: number;
  highValue: number;
}

interface ItemGroup {
  key: string;
  title: string;
  subtitle: string;
  entries: VisibleItem[];
}

interface DestinationDraftRow extends RoomOption {
  originalCode?: string;
}

let mode: Mode = 'live';
let filter: StatusFilter = 'remaining';
let groupBy: GroupBy = 'none';
let sortBy: SortBy = 'item-asc';
let queryText = '';
let filters: FilterState = {
  originalRoom: 'ALL',
  packType: 'ALL',
  destination: 'ALL',
  crate: 'ALL',
  rangeFrom: '',
  rangeTo: ''
};
let events: MoveEvent[] = [];
let meta: AppMeta = { deviceId: crypto.randomUUID(), deviceName: 'Unassigned device' };
let localDbReady = false;
let serviceWorkerReady = false;
let updateAvailable = false;
const RECEIPT_GRACE_MS = 10_000;
let searchTimer: number | undefined;
let deferredFullRender = false;
let receiptGraceTimer: number | undefined;
let loginBusy = false;
let showSettings = false;
let showEmergencyModal = false;
let editingEmergencyItemId: string | undefined;
let destinationDraft: DestinationDraftRow[] | undefined;
const animatedReceiptIds = new Set<string>();
let floatingLookupExpanded = false;
let floatingLookupVisible = false;
let lookupObserver: IntersectionObserver | undefined;
let lookupObserverFrame: number | undefined;
let bulkPlannerOpen = false;
let bulkPlannerSelectedRoom = '';
let bulkPlannerKeepOriginal = false;
let bulkPlannerCode = '';
let bulkPlannerLabel = '';
let bulkPlannerBusy = false;
let bulkSyncInProgress = false;
let bulkSyncRenderQueued = false;
let toastMessage = '';
let toastTimer: number | undefined;
let cloudStatus: FirebaseRuntimeStatus = {
  enabled: false,
  authReady: false,
  authenticated: false,
  authorized: false,
  connected: navigator.onLine,
  snapshotLoaded: false,
  inventoryLoaded: false
};
let installPrompt: BeforeInstallPromptEvent | undefined;
let applyServiceWorkerUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined;

const sync = new FirebaseSync({
  onEvents: async () => {
    events = await getAllEvents();
    if (bulkSyncInProgress) {
      bulkSyncRenderQueued = true;
      return;
    }
    renderOrRefreshDuringSearch();
  },
  onInventory: async (secureInventory) => {
    verifyRuntimeInventory(secureInventory);
    setInventory(secureInventory);
    await putCachedInventory(secureInventory);
    inventoryCached = true;
    render();
  },
  onAuthorizedUser: async (user) => {
    meta = {
      ...meta,
      lastAuthorizedUid: user.uid,
      lastAuthorizedUsername: user.username
    };
    await putMeta(meta);
    render();
  },
  onStatus: (status) => {
    cloudStatus = status;
    if (bulkSyncInProgress) {
      bulkSyncRenderQueued = true;
      return;
    }
    renderOrRefreshDuringSearch();
  }
});

void initialize();

async function initialize(): Promise<void> {
  localDbReady = await verifyLocalDatabase();
  meta = (await getMeta()) ?? meta;
  if (meta.deviceName === 'Unassigned device') {
    meta.deviceName = suggestedDeviceName();
    await putMeta(meta);
  }

  const cachedInventory = await getCachedInventory();
  if (cachedInventory) {
    verifyRuntimeInventory(cachedInventory);
    setInventory(cachedInventory);
    inventoryCached = true;
  }
  events = await getAllEvents();

  applyServiceWorkerUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateAvailable = true;
      render();
    },
    onOfflineReady() {
      serviceWorkerReady = true;
      render();
    },
    onRegisteredSW() {
      void navigator.serviceWorker.ready.then(() => {
        serviceWorkerReady = true;
        render();
      });
    },
    onRegisterError(error: unknown) {
      console.error('Service worker registration failed', error);
    }
  });

  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.ready.then(() => {
      serviceWorkerReady = true;
      render();
    });
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as BeforeInstallPromptEvent;
    render();
  });
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  window.addEventListener('resize', scheduleLookupObserver);
  window.addEventListener('orientationchange', scheduleLookupObserver);

  attachGlobalHandlers();
  render();
  await sync.start();
}

function render(): void {
  if (!cloudStatus.enabled) {
    appRoot.innerHTML = renderSetupGate();
    clearFloatingLookupLayout();
    return;
  }
  if (!cloudStatus.authReady) {
    appRoot.innerHTML = renderSecureLoading('Restoring the saved device session…');
    clearFloatingLookupLayout();
    return;
  }

  const offlineTrusted = Boolean(
    !navigator.onLine &&
    cloudStatus.authenticated &&
    cloudStatus.user?.uid &&
    cloudStatus.user.uid === meta.lastAuthorizedUid
  );
  const accessGranted = cloudStatus.authenticated && (cloudStatus.authorized || offlineTrusted);

  if (!cloudStatus.authenticated) {
    appRoot.innerHTML = renderLoginGate();
    clearFloatingLookupLayout();
    return;
  }
  if (!accessGranted) {
    appRoot.innerHTML = cloudStatus.lastError
      ? renderAccessDenied()
      : renderSecureLoading('Checking this account’s move access…');
    clearFloatingLookupLayout();
    return;
  }
  if (!inventoryCached || inventory.items.length === 0) {
    appRoot.innerHTML = renderSecureLoading(
      navigator.onLine
        ? 'Downloading the private 388-piece inventory to this device…'
        : 'This device has not downloaded the inventory yet. Connect once, then reopen the app.'
    );
    clearFloatingLookupLayout();
    return;
  }

  lookupObserver?.disconnect();
  lookupObserver = undefined;

  const crateListing = crateFeaturesEnabled();
  normalizeCrateUiState(crateListing);
  const workingItems = getWorkingItems();
  const states = buildStates(workingItems);
  scheduleReceiptGraceRefresh(states);
  const visibleEntries = buildVisibleEntries(workingItems, states);
  const counts = calculateCounts(workingItems, states);

  appRoot.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-lockup">
          <img class="brand-graphic" src="./graphics/move-boxes.svg" alt="" />
          <div>
            <p class="eyebrow">Private household move</p>
            <h1>${escapeHtml(moveConfig.title)}</h1>
          </div>
        </div>
        <button class="icon-button" data-action="device-settings" aria-label="Device and account settings">${icon('settings')}</button>
      </header>

      ${updateAvailable ? '<div class="banner warning update-banner"><span>An update is ready. Apply it before move day or during a safe pause, never while an item is being checked in.</span><button data-action="apply-app-update">Apply update now</button></div>' : ''}
      ${inventory.metadata.status !== 'verified' ? '<div class="banner danger">The inventory is not verified, so live receiving is locked.</div>' : ''}

      <section class="status-strip" aria-label="System status">
        ${statusPill(navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? 'ok' : 'neutral')}
        ${statusPill(serviceWorkerReady ? 'App cached' : 'Caching app', serviceWorkerReady ? 'ok' : 'warn')}
        ${statusPill(cloudLabel(), cloudTone())}
        ${statusPill(`@${cloudStatus.user?.username ?? 'user'}`, 'ok')}
        ${statusPill(meta.deviceName, 'neutral')}
      </section>

      <nav class="mode-tabs" aria-label="App mode">
        ${modeButton('live', 'check', 'Live Move')}
        ${modeButton('planning', 'room', 'Planning')}
        ${modeButton('readiness', 'shield', 'Readiness')}
      </nav>

      ${mode === 'readiness'
        ? renderReadiness(counts, workingItems)
        : renderWorkMode(visibleEntries, workingItems, states, counts)}

      <footer>
        <span>App v${escapeHtml(moveConfig.appVersion)} · Inventory ${escapeHtml(inventory.metadata.version)}</span>
        <span>${inventory.items.length} verified${counts.extras ? ` + ${counts.extras} extra` : ''}${crateListing ? ` · ${physicalCrates.length} current crates` : ''}</span>
      </footer>
    </div>
    <input id="backup-import" type="file" accept="application/json,.json" hidden />
    <datalist id="room-options">
      ${getDestinationCatalog().filter((room) => room.active).map((room) => `<option value="${escapeHtml(room.code)}">${escapeHtml(room.label)}</option>`).join('')}
    </datalist>
    <datalist id="pack-options">
      ${getPackTypes(workingItems).map((pack) => `<option value="${escapeHtml(pack)}"></option>`).join('')}
    </datalist>
    ${showSettings ? renderSettingsModal() : ''}
    ${showEmergencyModal ? renderEmergencyModal(workingItems, states) : ''}
    ${toastMessage ? `<div class="success-toast" role="status" aria-live="polite">${icon('check')}<span>${escapeHtml(toastMessage)}</span></div>` : ''}
  `;
  scheduleLookupObserver();
}

function scheduleLookupObserver(): void {
  if (lookupObserverFrame !== undefined) window.cancelAnimationFrame(lookupObserverFrame);
  lookupObserverFrame = window.requestAnimationFrame(() => {
    lookupObserverFrame = undefined;
    setupLookupObserver();
  });
}

function setupLookupObserver(): void {
  lookupObserver?.disconnect();
  lookupObserver = undefined;

  const sentinel = document.querySelector<HTMLElement>('.lookup-sentinel');
  if (!sentinel || mode === 'readiness') {
    setFloatingLookupVisible(false);
    return;
  }

  const updateFromPosition = (): void => {
    const shouldFloat = sentinel.getBoundingClientRect().top <= 0;
    setFloatingLookupVisible(shouldFloat);
  };

  lookupObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry) return;
      const shouldFloat = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      setFloatingLookupVisible(shouldFloat);
    },
    { threshold: 0 }
  );
  lookupObserver.observe(sentinel);
  updateFromPosition();
}

function setFloatingLookupVisible(visible: boolean): void {
  floatingLookupVisible = visible;
  if (!visible) floatingLookupExpanded = false;
  document.documentElement.classList.toggle('lookup-floating-active', visible);
  syncFloatingLookupUi();
}

function mountFloatingLookup(): void {
  const host = document.querySelector<HTMLElement>('#floating-lookup-host');
  const source = document.querySelector<HTMLElement>('.sticky-controls');
  if (!host || !source) return;

  const existing = host.querySelector<HTMLElement>('.floating-lookup');
  if (existing) {
    existing.classList.toggle('is-expanded', floatingLookupExpanded);
    existing.setAttribute('aria-hidden', String(!floatingLookupVisible));
    return;
  }

  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.add('floating-lookup');
  clone.classList.remove('has-exact-result');
  clone.setAttribute('aria-label', 'Floating inventory lookup');
  clone.setAttribute('aria-hidden', String(!floatingLookupVisible));

  clone.querySelectorAll<HTMLElement>('[id]').forEach((element) => {
    const sourceId = element.id;
    element.dataset.sourceId = sourceId;
    element.id = `floating-${sourceId}`;
  });
  clone.querySelectorAll<HTMLLabelElement>('label[for]').forEach((label) => {
    const forId = label.htmlFor;
    if (forId) label.htmlFor = `floating-${forId}`;
  });

  clone.classList.toggle('is-expanded', floatingLookupExpanded);
  host.replaceChildren(clone);
}

function syncFloatingLookupUi(): void {
  const host = document.querySelector<HTMLElement>('#floating-lookup-host');
  if (!host) return;

  if (!floatingLookupVisible) {
    host.replaceChildren();
    return;
  }

  mountFloatingLookup();
  const floating = host.querySelector<HTMLElement>('.floating-lookup');
  if (!floating) return;

  floating.classList.toggle('is-expanded', floatingLookupExpanded);
  floating.setAttribute('aria-hidden', 'false');

  floating.querySelectorAll<HTMLInputElement>('[data-search-input]').forEach((input) => {
    if (input.value !== queryText) input.value = queryText;
  });
  floating.querySelectorAll<HTMLButtonElement>('.search-clear').forEach((button) => {
    button.hidden = !queryText;
  });

  const toggle = floating.querySelector<HTMLButtonElement>('.mobile-lookup-toggle');
  const label = toggle?.querySelector<HTMLElement>('.mobile-lookup-toggle-label');
  const chevron = toggle?.querySelector<HTMLElement>('.mobile-lookup-chevron');
  toggle?.setAttribute('aria-expanded', String(floatingLookupExpanded));
  if (label) label.textContent = floatingLookupExpanded ? 'Hide views & filters' : 'Views & filters';
  if (chevron) chevron.textContent = floatingLookupExpanded ? '▲' : '▼';
}

function clearFloatingLookupLayout(): void {
  lookupObserver?.disconnect();
  lookupObserver = undefined;
  floatingLookupVisible = false;
  floatingLookupExpanded = false;
  document.documentElement.classList.remove('lookup-floating-active');
  document.querySelector<HTMLElement>('#floating-lookup-host')?.replaceChildren();
}

function renderOrRefreshDuringSearch(): void {
  if (isSearchInput(document.activeElement) && mode !== 'readiness') {
    deferredFullRender = true;
    refreshSearchResults();
    return;
  }
  render();
}

function renderPreservingScroll(): void {
  const scrollY = window.scrollY;
  render();
  window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
}

function renderPreservingElementPosition(selector: string): void {
  const before = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().top;
  render();
  if (before === undefined) return;
  window.requestAnimationFrame(() => {
    const after = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().top;
    if (after === undefined) return;
    window.scrollBy({ top: after - before, behavior: 'auto' });
  });
}

function refreshSearchResults(): void {
  if (mode === 'readiness' || !inventoryCached) return;
  const workingItems = getWorkingItems();
  const states = buildStates(workingItems);
  const visibleEntries = buildVisibleEntries(workingItems, states);
  const groups = buildGroups(visibleEntries);
  const exactEntry = visibleEntries.length === 1 ? visibleEntries[0] : undefined;
  const exactResult = Boolean(exactEntry?.match.exactId);

  document.querySelectorAll<HTMLElement>('[data-search-count]').forEach((element) => {
    element.textContent = String(visibleEntries.length);
  });
  document.querySelectorAll<HTMLElement>('[data-search-noun]').forEach((element) => {
    element.textContent = visibleEntries.length === 1 ? 'result' : 'results';
  });

  document.querySelectorAll<HTMLButtonElement>('.search-clear').forEach((button) => {
    button.hidden = !queryText;
  });

  document.querySelectorAll<HTMLElement>('.sticky-controls, .floating-lookup').forEach((controls) => {
    controls.classList.toggle('has-exact-result', exactResult);
  });

  const exactRegion = document.querySelector<HTMLElement>('#exact-match-region');
  if (exactRegion) exactRegion.innerHTML = exactResult && exactEntry ? renderExactMatchCallout(exactEntry) : '';

  const resultRegion = document.querySelector<HTMLElement>('#inventory-results');
  if (resultRegion) {
    resultRegion.innerHTML = `${groups.map((group) => renderGroup(group)).join('')}${visibleEntries.length === 0 ? renderEmptyState() : ''}`;
  }

  syncFloatingLookupUi();
}

function isSearchInput(element: Element | null): boolean {
  return element instanceof HTMLInputElement && element.matches('[data-search-input]');
}

function renderSetupGate(): string {
  return `
    <main class="secure-gate">
      <section class="secure-card">
        <div class="secure-mark">${icon('shield')}</div>
        <p class="eyebrow">Setup required</p>
        <h1>${escapeHtml(moveConfig.title)}</h1>
        <p>Firebase is not configured in <code>src/config/firebase.config.ts</code>. The private inventory is intentionally not bundled into the public website.</p>
      </section>
    </main>`;
}

function renderSecureLoading(message: string): string {
  return `
    <main class="secure-gate">
      <section class="secure-card">
        <div class="secure-mark">${icon('shield')}</div>
        <p class="eyebrow">Private family access</p>
        <h1>${escapeHtml(moveConfig.title)}</h1>
        <div class="loading-line"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>
        ${cloudStatus.lastError ? `<div class="banner danger">${escapeHtml(cloudStatus.lastError)}</div>` : ''}
      </section>
    </main>`;
}

function renderLoginGate(): string {
  return `
    <main class="secure-gate">
      <section class="secure-card">
        <div class="secure-mark">${icon('shield')}</div>
        <p class="eyebrow">Private family access</p>
        <h1>${escapeHtml(moveConfig.title)}</h1>
        <p>Sign in once on this phone before move day. The saved session and device identity remain available after closing the app and while offline.</p>
        <form id="login-form" class="login-form" autocomplete="on">
          <label><span>Username</span><input id="login-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required /></label>
          <label><span>Password</span><input id="login-password" name="password" type="password" autocomplete="current-password" required /></label>
          <label class="remember-row"><input id="remember-device" type="checkbox" checked /><span>Keep me signed in on this device</span></label>
          <button class="primary-button" type="submit" ${loginBusy ? 'disabled' : ''}>${loginBusy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        ${cloudStatus.lastError ? `<div class="banner danger">${escapeHtml(cloudStatus.lastError)}</div>` : ''}
        <p class="secure-note">There is no signup page. Authorized accounts are created only through the private Firebase administration setup.</p>
      </section>
    </main>`;
}

function renderAccessDenied(): string {
  return `
    <main class="secure-gate">
      <section class="secure-card">
        <div class="secure-mark">${icon('alert')}</div>
        <p class="eyebrow">Access blocked</p>
        <h1>${escapeHtml(moveConfig.title)}</h1>
        <div class="banner danger">${escapeHtml(cloudStatus.lastError ?? 'This account is not authorized for this move.')}</div>
        <button class="secondary-button" data-action="sign-out">Return to sign in</button>
      </section>
    </main>`;
}

function renderSettingsModal(): string {
  const user = cloudStatus.user;
  const sharedSettings = deriveMoveSettings(events);
  const settingsUpdated = sharedSettings.updatedAt
    ? `${formatDateTime(sharedSettings.updatedAt)}${sharedSettings.updatedByUsername ? ` by @${sharedSettings.updatedByUsername}` : ''}`
    : 'Using the safe default: crate features hidden';
  const catalog = destinationDraft ?? getDestinationCatalog().map((room) => ({ ...room, originalCode: room.code }));
  const catalogUpdated = latestDestinationCatalogEvent();
  return `
    <div class="modal-backdrop" data-action="close-settings">
      <section class="settings-modal settings-modal-wide" role="dialog" aria-modal="true" aria-label="Device, move, and destination settings" data-modal-panel>
        <div class="modal-header"><div><p class="eyebrow">Device, account, and shared move options</p><h2>Move access and destinations</h2></div><button class="icon-button" data-action="close-settings" aria-label="Close">×</button></div>
        <dl class="settings-list">
          <dt>Signed in</dt><dd>@${escapeHtml(user?.username ?? '')}</dd>
          <dt>Device name</dt><dd>${escapeHtml(meta.deviceName)}</dd>
          <dt>Device ID</dt><dd><code>${escapeHtml(meta.deviceId)}</code></dd>
          <dt>Session</dt><dd>Saved locally until you explicitly sign out</dd>
        </dl>

        <section class="shared-setting-card">
          <div class="shared-setting-heading">${icon('crate')}<div><strong>Do we have a current crate listing?</strong><span>This is a shared move setting. Changing it updates Bennett, Mom, and Dad after synchronization.</span></div></div>
          <label class="toggle-row">
            <input id="shared-crate-listing" type="checkbox" ${sharedSettings.hasCrateListing ? 'checked' : ''} />
            <span class="toggle-control" aria-hidden="true"></span>
            <span><b>${sharedSettings.hasCrateListing ? 'Crate features are shown' : 'Crate features are hidden'}</b><small>Turn this on only if the movers provide a reliable current crate-to-item listing.</small></span>
          </label>
          <p class="setting-updated">${escapeHtml(settingsUpdated)}</p>
          <button class="secondary-button shared-setting-save" data-action="save-shared-settings">Save shared move setting</button>
        </section>

        <section class="destination-manager-card">
          <div class="destination-manager-heading">
            ${icon('catalog')}
            <div><strong>Shared destination code and room list</strong><span>Add, rename, activate, or remove destination choices. The same list synchronizes to every authorized device.</span></div>
          </div>
          <p class="destination-manager-note">Use short codes that movers can read quickly. “Keep original room name” can route Kitchen, Master Bedroom, and other unchanged rooms without retyping either field.</p>
          <div class="destination-editor-list">
            ${catalog.map((room, index) => renderDestinationEditorRow(room, index)).join('')}
          </div>
          <div class="destination-manager-actions">
            <button class="secondary-button" data-action="add-destination-row">${icon('plus')} Add destination</button>
            <label class="remember-row migration-row"><input id="migrate-destination-assignments" type="checkbox" checked /><span>Update pieces already routed with any code or label I rename</span></label>
          </div>
          <button class="primary-button destination-save-button" data-action="save-destination-catalog">${icon('catalog')} Save shared destination list</button>
          <p class="setting-updated">${catalogUpdated ? `Last saved ${escapeHtml(formatDateTime(catalogUpdated.clientAt))}${catalogUpdated.actorUsername ? ` by @${escapeHtml(catalogUpdated.actorUsername)}` : ''}` : 'Using the built-in destination list until the first save.'}</p>
        </section>

        <label class="settings-field"><span>Rename this device</span><input id="device-name-setting" value="${escapeHtml(meta.deviceName)}" maxlength="80" /></label>
        <div class="settings-actions">
          <button class="primary-button" data-action="save-device-name">Save device name</button>
          <button class="secondary-button" data-action="copy-device-id">Copy device ID</button>
          <button class="secondary-button danger-button" data-action="sign-out">Sign out</button>
          <button class="text-button" data-action="forget-device">Sign out and clear this device’s local move data</button>
        </div>
      </section>
    </div>`;
}

function renderDestinationEditorRow(room: DestinationDraftRow, index: number): string {
  return `
    <div class="destination-editor-row" data-destination-row data-index="${index}" data-original-code="${escapeHtml(room.originalCode ?? room.code)}">
      <label><span>Code</span><input data-destination-field="code" value="${escapeHtml(room.code)}" maxlength="40" autocapitalize="characters" spellcheck="false" placeholder="MASTER" /></label>
      <label class="destination-label-field"><span>Room label</span><input data-destination-field="label" value="${escapeHtml(room.label)}" maxlength="120" placeholder="Master Bedroom" /></label>
      <label class="destination-active-field"><input data-destination-field="active" type="checkbox" ${room.active ? 'checked' : ''} /><span>Show</span></label>
      <button class="destination-remove-button" data-action="remove-destination-row" data-index="${index}" aria-label="Remove ${escapeHtml(room.label || 'destination')}">${icon('trash')}</button>
    </div>`;
}

function renderEmergencyModal(items: InventoryItem[], states: Map<string, DerivedItemState>): string {
  const editingItem = editingEmergencyItemId
    ? items.find((item) => item.itemId === editingEmergencyItemId && item.isAdHoc)
    : undefined;
  const state = editingItem ? states.get(editingItem.itemId) ?? emptyState() : emptyState();
  const currentDetails = editingItem ? latestItemDetailEvent(editingItem.itemId, events) : undefined;
  const description = String(currentDetails?.payload.description ?? editingItem?.sourceFields.Content ?? '');
  const comments = String(currentDetails?.payload.comments ?? editingItem?.sourceFields.Comments ?? '');
  const packType = String(currentDetails?.payload.packType ?? editingItem?.originalCode ?? '');
  const observedArea = String(currentDetails?.payload.observedArea ?? editingItem?.originalRoom ?? '');
  const crateId = state.assignedCrateId || editingItem?.crateId || 'UNASSIGNED';

  return `
    <div class="modal-backdrop emergency-backdrop" data-action="close-emergency-modal">
      <section class="settings-modal emergency-modal" role="dialog" aria-modal="true" aria-label="${editingItem ? 'Edit unexpected item' : 'Add unexpected item'}" data-modal-panel>
        <div class="modal-header">
          <div><p class="eyebrow">Move-day backup</p><h2>${editingItem ? 'Edit unexpected item' : 'Add something not on the list'}</h2></div>
          <button class="icon-button" data-action="close-emergency-modal" aria-label="Close">×</button>
        </div>
        <p class="modal-explainer">Use this only when a physical item arrives but cannot be matched to Inventory Items 1–388.</p>
        <form id="emergency-item-form" class="emergency-form" data-editing-item-id="${escapeHtml(editingItem?.itemId ?? '')}">
          <label class="full-width"><span>Item name or description *</span><input id="emergency-description" value="${escapeHtml(description)}" placeholder="Example: loose framed picture" maxlength="300" required autofocus /></label>
          <label class="full-width"><span>Details visible on the item</span><textarea id="emergency-comments" rows="2" maxlength="1000" placeholder="Color, brand, label, damage, serial number…">${escapeHtml(comments)}</textarea></label>
          <label><span>Package type</span><input id="emergency-pack" list="pack-options" value="${escapeHtml(packType)}" placeholder="Loose item, 4.5 Carton…" maxlength="120" /></label>
          <label><span>Observed area / clue</span><input id="emergency-area" value="${escapeHtml(observedArea)}" placeholder="Truck, kitchen staging, hallway…" maxlength="120" /></label>
          ${crateFeaturesEnabled() ? `<label><span>Current delivery crate (manual)</span><select id="emergency-crate">${inventory.crates.map((crate) => `<option value="${escapeHtml(crate.crateId)}" ${crate.crateId === crateId ? 'selected' : ''}>${escapeHtml(crate.displayName)}</option>`).join('')}</select></label>` : ''}
          <label><span>Destination code</span><input id="emergency-code" list="room-options" value="${escapeHtml(state.destinationCode ?? '')}" placeholder="A, KITCHEN, HOLD…" maxlength="40" /></label>
          <label class="full-width"><span>Destination label</span><input id="emergency-label" value="${escapeHtml(state.destinationLabel ?? '')}" placeholder="Kitchen / Room A / Hold" maxlength="120" /></label>
          <label class="full-width"><span>Move notes</span><textarea id="emergency-notes" rows="2" maxlength="2000" placeholder="Fragile, ask Dad, place against wall…">${escapeHtml(state.notes ?? '')}</textarea></label>
          ${editingItem ? '' : '<label class="remember-row full-width"><input id="emergency-received" type="checkbox" checked /><span>Mark this item received immediately</span></label>'}
          <button class="primary-button full-width" type="submit">${editingItem ? 'Save extra item details' : 'Add item and continue unloading'}</button>
          ${editingItem ? '<button class="secondary-button danger-button full-width" type="button" data-action="void-emergency-item" data-item-id="' + escapeHtml(editingItem.itemId) + '">Remove this accidental extra</button>' : ''}
        </form>
      </section>
    </div>`;
}

function setInventory(bundle: InventoryBundle): void {
  inventory = bundle;
  physicalCrates = inventory.crates.filter((crate) => crate.isPhysical !== false);
}

function crateFeaturesEnabled(): boolean {
  return deriveMoveSettings(events).hasCrateListing;
}

function normalizeCrateUiState(enabled: boolean): void {
  if (enabled) return;
  if (groupBy === 'crate') groupBy = 'none';
  filters.crate = 'ALL';
  if (filter === 'no-crate') filter = mode === 'live' ? 'remaining' : 'all';
}

function isReceiptInGrace(state: DerivedItemState): boolean {
  return Boolean(state.received && state.receivedAt && Date.now() < state.receivedAt + RECEIPT_GRACE_MS);
}

function scheduleReceiptGraceRefresh(states: Map<string, DerivedItemState>): void {
  window.clearTimeout(receiptGraceTimer);
  receiptGraceTimer = undefined;
  if (mode !== 'live' || filter === 'received') return;
  const deadlines = [...states.values()]
    .filter((state) => isReceiptInGrace(state) && state.receivedAt)
    .map((state) => (state.receivedAt as number) + RECEIPT_GRACE_MS);
  if (!deadlines.length) return;
  const nextDeadline = Math.min(...deadlines);
  receiptGraceTimer = window.setTimeout(() => render(), Math.max(30, nextDeadline - Date.now() + 30));
}

function verifyRuntimeInventory(bundle: InventoryBundle): void {
  if (bundle.metadata.status !== 'verified' || bundle.items.length !== 388) {
    throw new Error('The secure inventory failed its runtime integrity check.');
  }
  const ids = bundle.items.map((item) => Number(item.itemId));
  if (!ids.every((id, index) => id === index + 1)) {
    throw new Error('The secure inventory IDs are not continuous from 1 through 388.');
  }
}

function emptyInventoryBundle(): InventoryBundle {
  return {
    metadata: {
      title: 'Secure inventory not loaded',
      version: 'secure-cloud',
      generatedAt: '',
      status: 'placeholder',
      expectedCrateCount: moveConfig.expectedCrateCount,
      expectedItemCount: 388,
      sourceDocuments: []
    },
    crates: [],
    items: []
  };
}

function getWorkingItems(): InventoryItem[] {
  return [...inventory.items, ...deriveAdHocItems(events)];
}

function buildStates(items: InventoryItem[]): Map<string, DerivedItemState> {
  return new Map(items.map((item) => [item.itemId, deriveItemState(item.itemId, events)]));
}

function calculateCounts(items: InventoryItem[], states: Map<string, DerivedItemState>): CountSummary {
  const total = items.length;
  const received = items.filter((item) => states.get(item.itemId)?.received).length;
  const issues = items.reduce((sum, item) => sum + (states.get(item.itemId)?.issueCount ?? 0), 0);
  const destinationAssigned = items.filter((item) => hasDestination(item, states.get(item.itemId) ?? emptyState())).length;
  const crateAssigned = items.filter((item) => effectiveCrate(item, states.get(item.itemId) ?? emptyState()) !== 'UNASSIGNED').length;
  const highValue = items.filter(isHighValue).length;
  const extras = items.filter((item) => item.isAdHoc).length;
  return {
    total,
    verified: inventory.items.length,
    extras,
    received,
    issues,
    destinationAssigned,
    crateAssigned,
    highValue
  };
}

function buildVisibleEntries(items: InventoryItem[], states: Map<string, DerivedItemState>): VisibleItem[] {
  const entries = items
    .map((item) => {
      const state = states.get(item.itemId) ?? emptyState();
      return { item, state, match: evaluateSearch(item, state, queryText) } satisfies VisibleItem;
    })
    .filter((entry) => entry.match.matched && (entry.match.exactId || passesFilters(entry.item, entry.state)));

  return sortEntries(entries);
}

function renderWorkMode(
  visibleEntries: VisibleItem[],
  workingItems: InventoryItem[],
  states: Map<string, DerivedItemState>,
  counts: CountSummary
): string {
  const groups = buildGroups(visibleEntries);
  const activeFilterCount = countActiveFilters();
  const exactEntry = visibleEntries.length === 1 ? visibleEntries[0] : undefined;
  const exactResult = Boolean(exactEntry?.match.exactId);

  return `
    ${renderMoveProgressHero(counts)}
    <section class="dashboard-grid">
      ${metric('Received', counts.received, counts.total ? `${Math.round((counts.received / counts.total) * 100)}% complete` : '0%', 'green', percent(counts.received, counts.total), 'check')}
      ${metric('Remaining', Math.max(0, counts.total - counts.received), 'pieces still on truck', 'amber', percent(Math.max(0, counts.total - counts.received), counts.total), 'box')}
      ${metric('Routed', counts.destinationAssigned, `${Math.max(0, counts.total - counts.destinationAssigned)} left to plan`, 'blue', percent(counts.destinationAssigned, counts.total), 'destination')}
      ${metric('Issues', counts.issues, counts.issues ? 'needs review' : 'all clear', counts.issues ? 'red' : 'slate', Math.min(100, counts.issues * 10), 'alert')}
    </section>

    ${mode === 'planning' ? renderPlanningNotice() + renderBulkTools(workingItems) : ''}

    <section class="controls sticky-controls ${exactResult ? 'has-exact-result' : ''}">
      <div class="lookup-intro">
        <div class="search-heading">
          <div><p class="eyebrow">Fast lookup</p><h2>${mode === 'live' ? 'Find it, call the room, check it in' : 'Find and route inventory'}</h2></div>
          ${mode === 'live' ? `<button class="emergency-add-inline" data-action="open-emergency-modal">${icon('add')}<span>Unexpected item</span></button>` : ''}
        </div>
      </div>
      <label class="search-box enhanced-search">
        ${icon('search')}
        <span class="sr-only">Search inventory</span>
        <input id="search-input" data-search-input type="search" value="${escapeHtml(queryText)}" placeholder="2 = Item 2 · piano · pack:3.1 · 1-40" autocomplete="off" inputmode="search" enterkeyhint="search" />
        <button type="button" class="search-clear" data-action="clear-search" aria-label="Clear search" ${queryText ? '' : 'hidden'}>×</button>
      </label>
      <div class="mobile-lookup-toolbar">
        <span class="mobile-result-count"><strong data-search-count>${visibleEntries.length}</strong> <span data-search-noun>result${visibleEntries.length === 1 ? '' : 's'}</span></span>
        <button type="button" class="mobile-lookup-toggle" data-action="toggle-floating-lookup" aria-expanded="${floatingLookupExpanded ? 'true' : 'false'}">
          ${icon('filter')}<span class="mobile-lookup-toggle-label">${floatingLookupExpanded ? 'Hide views & filters' : 'Views & filters'}</span><span class="mobile-lookup-chevron" aria-hidden="true">${floatingLookupExpanded ? '▲' : '▼'}</span>
        </button>
      </div>
      <div class="lookup-options">
        <div class="search-meta">
          <span><strong data-search-count>${visibleEntries.length}</strong> <span data-search-noun>result${visibleEntries.length === 1 ? '' : 's'}</span></span>
          <span>Exact number search · ranges · descriptions · comments · package types</span>
        </div>

        <div class="view-preset-row" aria-label="Quick inventory views">
          ${viewPresetButton('number', 'list', 'Number list', groupBy === 'none' && filter !== 'received')}
          ${viewPresetButton('original-room', 'original-room', 'Original rooms', groupBy === 'room' && filter !== 'received')}
          ${viewPresetButton('destination', 'destination', 'New rooms', groupBy === 'destination' && filter !== 'received')}
          ${viewPresetButton('checked', 'history', 'Checked off', filter === 'received')}
        </div>

        <div class="quick-filter-row" aria-label="Quick status filters">
          ${filterButton('all', 'All')}
          ${filterButton('remaining', 'Remaining')}
          ${filterButton('received', 'Received')}
          ${filterButton('issues', 'Issues')}
          ${filterButton('no-destination', 'Unrouted')}
          ${filterButton('high-value', 'High value')}
          ${filterButton('extra', 'Extras')}
        </div>

        <details class="advanced-filters" ${activeFilterCount ? 'open' : ''}>
          <summary>${icon('filter')}<span>Filters, grouping, and sorting</span>${activeFilterCount ? `<b>${activeFilterCount}</b>` : ''}</summary>
          <div class="filter-grid">
            <label><span>Original room</span><select id="filter-room">${selectOptions(['ALL', ...getOriginalRooms(workingItems)], filters.originalRoom, 'All original rooms')}</select></label>
            <label><span>Package type</span><select id="filter-pack">${selectOptions(['ALL', ...getPackTypes(workingItems)], filters.packType, 'All package types')}</select></label>
            <label><span>Destination</span><select id="filter-destination">${selectOptions(['ALL', ...getDestinations(workingItems, states)], filters.destination, 'All destinations')}</select></label>
            ${crateFeaturesEnabled() ? `<label><span>Current crate</span><select id="filter-crate">${selectOptions(['ALL', 'UNASSIGNED', ...physicalCrates.map((crate) => crate.crateId)], filters.crate, 'All current crates', crateOptionLabel)}</select></label>` : ''}
            <label><span>Group by</span><select id="group-select">${groupSelectOptions()}</select></label>
            <label><span>Sort</span><select id="sort-select">${sortSelectOptions()}</select></label>
            <div class="range-filter full-width">
              <label><span>Item number from</span><input id="filter-range-from" type="number" inputmode="numeric" min="1" max="388" value="${escapeHtml(filters.rangeFrom)}" placeholder="1" /></label>
              <label><span>Item number through</span><input id="filter-range-to" type="number" inputmode="numeric" min="1" max="388" value="${escapeHtml(filters.rangeTo)}" placeholder="388" /></label>
            </div>
            <button class="secondary-button full-width" data-action="clear-filters">Clear all filters and sorting</button>
          </div>
        </details>
      </div>
    </section>
    <div class="lookup-sentinel" aria-hidden="true"></div>
    <div id="floating-lookup-host" aria-live="polite"></div>

    <div id="exact-match-region">${exactResult && exactEntry ? renderExactMatchCallout(exactEntry) : ''}</div>

    <section class="crate-list" id="inventory-results">
      ${groups.map((group) => renderGroup(group)).join('')}
      ${visibleEntries.length === 0 ? renderEmptyState() : ''}
    </section>

    ${mode === 'live' ? `<button class="floating-add-button" data-action="open-emergency-modal" aria-label="Add an unexpected item">${icon('add')}<span>Add unexpected item</span></button>` : ''}
  `;
}

function renderPlanningNotice(): string {
  if (!crateFeaturesEnabled()) {
    return `
      <div class="package-warning package-info">
        ${icon('package')}
        <div><strong>Use package type as a fast planning filter.</strong><span>Values such as 3.1 Carton, 4.5 Carton, Dish Carton, and Wardrobe describe the container around each listed piece and can be filtered directly during planning.</span></div>
      </div>`;
  }
  return `
    <div class="package-warning">
      ${icon('package')}
      <div><strong>Package type is not a delivery crate.</strong><span>“3.1 Carton,” “4.5 Carton,” “Dish Carton,” and similar values describe the box or packing container. Current crate assignments should be used only with a reliable mover-provided listing.</span></div>
    </div>`;
}

function renderExactMatchCallout(entry: VisibleItem): string {
  const destination = destinationText(entry.item, entry.state);
  return `
    <section class="exact-match-callout">
      <div class="exact-check">${icon('search')}</div>
      <div><span>Exact item match</span><strong>${displayItemId(entry.item)} · ${escapeHtml(String(entry.item.sourceFields.Content ?? entry.item.description))}</strong></div>
      <div class="exact-destination">${escapeHtml(destination)}</div>
    </section>`;
}

function renderEmptyState(): string {
  return `
    <div class="empty-state enhanced-empty">
      <img src="./graphics/search-empty.svg" alt="" />
      <h3>No matching pieces</h3>
      <p>Try an exact item number, a description word, or clear one of the active filters.</p>
      <button class="secondary-button" data-action="clear-filters">Clear filters</button>
    </div>`;
}

function buildGroups(entries: VisibleItem[]): ItemGroup[] {
  if (groupBy === 'none') {
    return [{ key: 'results', title: 'Number list', subtitle: `${entries.length} piece${entries.length === 1 ? '' : 's'} in item-number order`, entries }];
  }

  const map = new Map<string, VisibleItem[]>();
  for (const entry of entries) {
    const key = groupKey(entry.item, entry.state);
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  }

  if (groupBy === 'crate') {
    const crateGroups = inventory.crates
      .map((crate) => ({
        key: crate.crateId,
        title: crate.displayName,
        subtitle: crate.crateId === 'UNASSIGNED' ? 'No reliable current crate mapping' : 'Current delivery crate (manual)',
        entries: map.get(crate.crateId) ?? []
      }))
      .filter((group) => group.entries.length > 0);
    const knownKeys = new Set(crateGroups.map((group) => group.key));
    for (const [key, groupEntries] of map.entries()) {
      if (!knownKeys.has(key)) crateGroups.push({ key, title: key, subtitle: 'Current delivery crate', entries: groupEntries });
    }
    return crateGroups;
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, groupEntries]) => ({
      key,
      title: key,
      subtitle: groupSubtitle(),
      entries: groupEntries
    }));
}

function groupKey(item: InventoryItem, state: DerivedItemState): string {
  if (groupBy === 'room') return item.originalRoom || 'Original room unknown';
  if (groupBy === 'pack') return item.originalCode || 'Package type unknown';
  if (groupBy === 'destination') return destinationFilterKey(item, state) === 'UNASSIGNED' ? 'Destination not assigned' : destinationFilterKey(item, state);
  return effectiveCrate(item, state);
}

function groupSubtitle(): string {
  if (groupBy === 'room') return 'Original 2024 room label';
  if (groupBy === 'pack') return 'Packing container type or size';
  if (groupBy === 'destination') return 'New move-in destination';
  return 'Inventory results';
}

function renderGroup(group: ItemGroup): string {
  const received = group.entries.filter((entry) => entry.state.received).length;
  const assigned = group.entries.filter((entry) => hasDestination(entry.item, entry.state)).length;
  if (group.key === 'results') {
    return `
      <section class="number-list-group">
        <header><div>${icon('list')}<div><strong>${escapeHtml(group.title)}</strong><span>${escapeHtml(group.subtitle)} · ${assigned}/${group.entries.length} routed</span></div></div><b>${received} checked</b></header>
        <div class="crate-items">${group.entries.map((entry) => renderItem(entry)).join('')}</div>
      </section>`;
  }
  const open = Boolean(queryText) || filter !== 'all' || countActiveFilters() > 0;
  return `
    <details class="crate" ${open ? 'open' : ''}>
      <summary>
        <div>
          <strong>${escapeHtml(group.title)}</strong>
          <span>${escapeHtml(group.subtitle)} · ${assigned}/${group.entries.length} routed</span>
        </div>
        <div class="crate-progress">${received}/${group.entries.length}</div>
      </summary>
      <div class="crate-items">
        ${group.entries.map((entry) => renderItem(entry)).join('')}
      </div>
    </details>`;
}

function renderItem(entry: VisibleItem): string {
  const { item, state, match } = entry;
  if (mode === 'live' && state.received && isReceiptInGrace(state) && filter !== 'received') {
    return renderRecentReceiptCard(entry);
  }
  const destination = destinationText(item, state);
  const crateId = effectiveCrate(item, state);
  const crate = inventory.crates.find((candidate) => candidate.crateId === crateId);
  const comments = String(item.sourceFields.Comments ?? '');
  const content = String(item.sourceFields.Content ?? item.description);
  const receivedLabel = state.received
    ? `Received${state.receivedBy ? ` by ${state.receivedBy}` : ''}${state.receivedByUsername ? ` (@${state.receivedByUsername})` : ''}${state.receivedAt ? ` · ${formatTime(state.receivedAt)}` : ''}`
    : 'Check in item';

  return `
    <article class="item-card ${state.received ? 'is-received' : ''} ${match.exactId ? 'exact-match-card' : ''} ${item.isAdHoc ? 'ad-hoc-card' : ''}" data-item-id="${escapeHtml(item.itemId)}">
      <div class="item-topline">
        <div class="item-identity">
          <span class="item-id">${displayItemId(item)}</span>
          <span class="sequence">${item.isAdHoc ? 'MOVE-DAY EXTRA' : `PDF p.${item.sourcePage ?? '?'}`}</span>
        </div>
        <div class="badge-row">
          ${item.isAdHoc ? '<span class="extra-badge">UNLISTED EXTRA</span>' : ''}
          ${isHighValue(item) ? '<span class="high-value-badge">HIGH VALUE</span>' : ''}
          ${state.issueCount ? `<span class="issue-badge">${state.issueCount} issue${state.issueCount === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
      <h3>${escapeHtml(content)}</h3>
      ${comments ? `<p class="item-description">${escapeHtml(comments)}</p>` : ''}
      ${queryText && match.reasons.length ? `<div class="match-reasons">Matched: ${match.reasons.map(escapeHtml).join(' · ')}</div>` : ''}

      <div class="destination-command ${hasDestination(item, state) ? '' : 'missing'}">
        ${icon('room')}
        <div><span>Send to</span><strong>${escapeHtml(destination)}</strong>${state.keepOriginalRoom ? '<small class="kept-original-badge">Original room kept</small>' : ''}</div>
      </div>

      <div class="metadata-grid ${crateFeaturesEnabled() ? '' : 'two-column'}">
        <div>${icon('package')}<span><b>Package</b>${escapeHtml(item.originalCode || 'Unspecified')}</span></div>
        <div>${icon('original-room')}<span><b>Original room</b>${escapeHtml(item.originalRoom || 'Unknown')}</span></div>
        ${crateFeaturesEnabled() ? `<div>${icon('crate')}<span><b>Current crate</b>${escapeHtml(crate?.displayName ?? (crateId === 'UNASSIGNED' ? 'Not mapped' : crateId))}</span></div>` : ''}
      </div>

      ${state.notes ? `<p class="notes"><strong>Move note:</strong> ${escapeHtml(state.notes)}</p>` : ''}
      ${state.latestIssue ? `<p class="issue-note">Latest issue: ${escapeHtml(state.latestIssue)}</p>` : ''}

      ${mode === 'live' ? renderLiveActions(item, state, receivedLabel) : renderPlanningActions(item, state)}

      <details class="source-details">
        <summary>Complete source record and generated search tags</summary>
        <p>${escapeHtml(item.rawLine)}</p>
        <dl>${Object.entries(item.sourceFields).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value ?? ''))}</dd>`).join('')}</dl>
        <p class="tags">${[...new Set([...item.tags, ...getGeneratedSearchTags(item, state)])].map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</p>
      </details>
    </article>`;
}

function renderRecentReceiptCard(entry: VisibleItem): string {
  const { item, state } = entry;
  const receipt = findActiveReceipt(item.itemId, events);
  const content = String(item.sourceFields.Content ?? item.description);
  const remainingMs = Math.max(100, ((state.receivedAt ?? Date.now()) + RECEIPT_GRACE_MS) - Date.now());
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const elapsedRatio = Math.max(0.02, Math.min(1, remainingMs / RECEIPT_GRACE_MS));
  const animateEntrance = Boolean(receipt && !animatedReceiptIds.has(receipt.id));
  if (receipt) animatedReceiptIds.add(receipt.id);
  return `
    <article class="recent-receipt-card ${animateEntrance ? 'receipt-first-show' : ''}" data-item-id="${escapeHtml(item.itemId)}">
      <div class="receipt-success-icon">${icon('check')}</div>
      <div class="recent-receipt-copy">
        <strong>${displayItemId(item)} checked in</strong>
        <span>${escapeHtml(content)} → ${escapeHtml(destinationText(item, state))}</span>
      </div>
      ${receipt ? `<button class="receipt-undo-button" data-action="unreceive" data-item-id="${escapeHtml(item.itemId)}" data-receipt-id="${escapeHtml(receipt.id)}">${icon('undo')} Undo</button>` : ''}
      <span class="receipt-countdown">Hides in ${remainingSeconds}s</span>
      <span class="receipt-progress" style="--receipt-ms:${Math.round(remainingMs)}ms;--receipt-ratio:${elapsedRatio.toFixed(4)}" aria-hidden="true"></span>
    </article>`;
}

function renderLiveActions(item: InventoryItem, state: DerivedItemState, receivedLabel: string): string {
  const locked = inventory.metadata.status !== 'verified' && moveConfig.requireVerifiedInventoryForLiveMode;
  const activeReceipt = findActiveReceipt(item.itemId, events);
  if (state.received) {
    return `
      <div class="live-actions received-actions">
        <div class="received-status-line">${icon('check')}<div><strong>${escapeHtml(receivedLabel)}</strong><span>${escapeHtml(destinationText(item, state))}</span></div></div>
        <div class="secondary-action-row">
          ${activeReceipt ? `<button class="secondary-button uncheck-button" data-action="unreceive" data-item-id="${escapeHtml(item.itemId)}" data-receipt-id="${escapeHtml(activeReceipt.id)}">${icon('undo')} Uncheck / return to remaining</button>` : ''}
          <button class="secondary-button" data-action="issue" data-item-id="${escapeHtml(item.itemId)}">${icon('alert')} Log issue</button>
          <button class="secondary-button" data-action="edit-item" data-item-id="${escapeHtml(item.itemId)}">${icon('destination')} Edit routing</button>
          ${item.isAdHoc ? `<button class="secondary-button" data-action="edit-emergency-item" data-item-id="${escapeHtml(item.itemId)}">${icon('edit')} Edit details</button>` : ''}
        </div>
      </div>`;
  }
  return `
    <div class="live-actions">
      <button class="receive-button" data-action="receive" data-item-id="${escapeHtml(item.itemId)}" ${locked ? 'disabled' : ''}>
        ${icon('check')}<span>Check in item</span>
      </button>
      <div class="secondary-action-row">
        <button class="secondary-button" data-action="issue" data-item-id="${escapeHtml(item.itemId)}">${icon('alert')} Log issue</button>
        <button class="secondary-button" data-action="edit-item" data-item-id="${escapeHtml(item.itemId)}">${icon('destination')} Edit routing</button>
        ${item.isAdHoc ? `<button class="secondary-button" data-action="edit-emergency-item" data-item-id="${escapeHtml(item.itemId)}">${icon('edit')} Edit details</button>` : ''}
      </div>
    </div>`;
}

function renderPlanningActions(item: InventoryItem, state: DerivedItemState): string {
  const crateId = effectiveCrate(item, state);
  const keepOriginal = state.keepOriginalRoom === true;
  return `
    <div class="planning-form">
      ${crateFeaturesEnabled() ? `<label>
        <span>Current delivery crate (manual)</span>
        <select id="crate-${safeId(item.itemId)}">
          ${inventory.crates.map((crate) => `<option value="${escapeHtml(crate.crateId)}" ${crate.crateId === crateId ? 'selected' : ''}>${escapeHtml(crate.displayName)}</option>`).join('')}
        </select>
      </label>` : ''}
      <label class="keep-original-control full-width">
        <input id="keep-original-${safeId(item.itemId)}" type="checkbox" ${keepOriginal ? 'checked' : ''} />
        <span class="keep-original-icon">${icon('keep')}</span>
        <span><b>Keep the original room name</b><small>Use “${escapeHtml(item.originalRoom || 'original room')}” as the final destination without entering a new code or label.</small></span>
      </label>
      <label class="destination-custom-field ${keepOriginal ? 'is-disabled' : ''}">
        <span>Destination code</span>
        <input id="code-${safeId(item.itemId)}" list="room-options" value="${escapeHtml(state.destinationCode ?? '')}" placeholder="A, B, KITCHEN…" ${keepOriginal ? 'disabled' : ''} />
      </label>
      <label class="destination-custom-field ${keepOriginal ? 'is-disabled' : ''}">
        <span>Destination label</span>
        <input id="label-${safeId(item.itemId)}" value="${escapeHtml(state.destinationLabel ?? '')}" placeholder="Room A / Kitchen / Garage" ${keepOriginal ? 'disabled' : ''} />
      </label>
      <label class="full-width">
        <span>Placement or handling notes</span>
        <textarea id="notes-${safeId(item.itemId)}" rows="2" placeholder="Against left wall, fragile, ask Dad…">${escapeHtml(state.notes ?? '')}</textarea>
      </label>
      <button class="primary-button full-width" data-action="save-plan" data-item-id="${escapeHtml(item.itemId)}">${icon('route')} Save piece routing</button>
      ${item.isAdHoc ? `<button class="secondary-button full-width" data-action="edit-emergency-item" data-item-id="${escapeHtml(item.itemId)}">Edit extra-item description</button>` : ''}
    </div>`;
}

function renderBulkTools(items: InventoryItem[]): string {
  const originalRooms = getOriginalRooms(items);
  const selectedRoom = originalRooms.includes(bulkPlannerSelectedRoom)
    ? bulkPlannerSelectedRoom
    : (originalRooms[0] ?? '');
  if (selectedRoom !== bulkPlannerSelectedRoom) bulkPlannerSelectedRoom = selectedRoom;
  const buttonLabel = bulkPlannerBusy ? 'Saving room assignment…' : 'Apply to every piece in this old room';
  return `
    <details class="bulk-panel" ${bulkPlannerOpen ? 'open' : ''}>
      <summary>${icon('room')} Fast planning tools</summary>
      <div class="bulk-grid">
        <section>
          <h3>Route an entire old room</h3>
          <p>Keep unchanged rooms exactly as they were, or assign a new shared destination code and label. Individual exceptions can still be changed later.</p>
          <label><span>Original room</span><select id="bulk-room" ${bulkPlannerBusy ? 'disabled' : ''}>${originalRooms.map((room) => `<option value="${escapeHtml(room)}" ${room === selectedRoom ? 'selected' : ''}>${escapeHtml(room)}</option>`).join('')}</select></label>
          <label class="keep-original-control bulk-keep-original">
            <input id="bulk-keep-original" type="checkbox" ${bulkPlannerKeepOriginal ? 'checked' : ''} ${bulkPlannerBusy ? 'disabled' : ''} />
            <span class="keep-original-icon">${icon('keep')}</span>
            <span><b>Keep original room name</b><small>Example: Kitchen stays Kitchen, Master Bedroom stays Master Bedroom.</small></span>
          </label>
          <div id="bulk-custom-destination" class="bulk-custom-destination ${bulkPlannerKeepOriginal ? 'is-disabled' : ''}">
            <label><span>New destination code</span><input id="bulk-code" list="room-options" value="${escapeHtml(bulkPlannerCode)}" placeholder="A, B, STORAGE…" ${bulkPlannerKeepOriginal || bulkPlannerBusy ? 'disabled' : ''} /></label>
            <label><span>New destination label</span><input id="bulk-label" value="${escapeHtml(bulkPlannerLabel)}" placeholder="Room A" ${bulkPlannerKeepOriginal || bulkPlannerBusy ? 'disabled' : ''} /></label>
          </div>
          <button class="primary-button bulk-route-button ${bulkPlannerBusy ? 'is-busy' : ''}" data-action="bulk-route-room" ${bulkPlannerBusy ? 'disabled aria-busy="true"' : ''}>${icon(bulkPlannerBusy ? 'progress' : 'route')} ${buttonLabel}</button>
          <p class="bulk-save-note" aria-live="polite">The planner stays open while room events sync, so you can continue directly to the next room.</p>
        </section>
        ${crateFeaturesEnabled() ? `<section>
          <h3>Assign a documented item range to a crate</h3>
          <p>Use this only when a present-day crate label or mover manifest explicitly gives a reliable Item 1–388 range.</p>
          <div class="range-row">
            <label><span>From item</span><input id="range-from" inputmode="numeric" type="number" min="1" max="388" /></label>
            <label><span>Through item</span><input id="range-to" inputmode="numeric" type="number" min="1" max="388" /></label>
          </div>
          <label><span>Current crate</span><select id="range-crate">${physicalCrates.map((crate) => `<option value="${escapeHtml(crate.crateId)}">${escapeHtml(crate.displayName)}</option>`).join('')}</select></label>
          <button class="primary-button" data-action="bulk-assign-crate">Assign range to crate</button>
        </section>` : ''}
      </div>
    </details>`;
}

function renderReadiness(counts: CountSummary, workingItems: InventoryItem[]): string {
  const ids = inventory.items.map((item) => Number(item.itemId));
  const continuousIds = ids.length === 388 && ids.every((id, index) => id === index + 1);
  const crateListing = crateFeaturesEnabled();
  const checks = [
    readinessCheck('Verified PDF inventory loaded', inventory.metadata.status === 'verified', `${inventory.items.length} master pieces`),
    readinessCheck('All inventory IDs 1-388 are present once', continuousIds, continuousIds ? 'Continuous and unique' : 'Review import audit'),
    ...(crateListing ? [readinessCheck('All 14 current delivery crates represented', physicalCrates.length === moveConfig.expectedCrateCount, `${physicalCrates.length}/${moveConfig.expectedCrateCount}`)] : []),
    readinessCheck('Local offline database works', localDbReady, localDbReady ? 'IndexedDB ready' : 'Failed'),
    readinessCheck('App files cached', serviceWorkerReady, serviceWorkerReady ? 'Offline shell ready' : 'Open once online and reload'),
    readinessCheck('Firebase security configured', cloudStatus.enabled, cloudStatus.enabled ? 'Authentication and Firestore enabled' : 'Not configured'),
    readinessCheck('Password session restored', cloudStatus.authenticated, cloudStatus.authenticated ? `Signed in as @${cloudStatus.user?.username ?? 'user'}` : 'Sign in required'),
    readinessCheck('Account authorized for this move', cloudStatus.authorized || (!navigator.onLine && cloudStatus.user?.uid === meta.lastAuthorizedUid), cloudStatus.authorized ? 'Active move membership confirmed' : 'Offline access uses the last confirmed membership'),
    readinessCheck('Private inventory cached on this device', inventoryCached && inventory.items.length === 388, inventoryCached ? '388 pieces available offline' : 'Open online once after sign-in'),
    readinessCheck('Initial cloud snapshot loaded', cloudStatus.snapshotLoaded, cloudStatus.snapshotLoaded ? 'Shared changes downloaded' : 'Reconnect once before move day'),
    readinessCheck('Every current piece has a destination', workingItems.length > 0 && counts.destinationAssigned === workingItems.length, `${counts.destinationAssigned}/${workingItems.length} routed`)
  ];

  return `
    <section class="readiness-panel">
      <div class="readiness-header">
        <div><p class="eyebrow">Preflight</p><h2>Move-day readiness</h2></div>
        <div class="readiness-score">${checks.filter((check) => check.includes('data-ready="true"')).length}/${checks.length}</div>
      </div>

      <div class="source-summary">
        <strong>Verified source summary</strong>
        <span>388 master inventory pieces${counts.extras ? ` plus ${counts.extras} move-day extra${counts.extras === 1 ? '' : 's'}` : ''}.</span>
      </div>
      ${crateListing ? `<div class="package-warning">${icon('package')}<div><strong>Package type does not identify the physical delivery crate.</strong><span>The source’s 3.1 Carton, 4.5 Carton, Dish Carton, Wardrobe, and similar labels are packing types. Use crate tools only with a reliable current listing.</span></div></div>` : ''}

      <div class="check-list">${checks.join('')}</div>
      ${crateListing ? `<div class="readiness-check informational"><span class="check-icon">i</span><div><strong>Current crate mapping</strong><span>${counts.crateAssigned}/${counts.total} pieces assigned.</span></div></div>` : ''}
      ${cloudStatus.lastError ? `<div class="banner danger">Cloud error: ${escapeHtml(cloudStatus.lastError)}</div>` : ''}

      <div class="action-grid">
        <button class="primary-button" data-action="device-settings">Device and shared settings</button>
        ${installPrompt ? '<button class="primary-button" data-action="install">Install app</button>' : '<button class="secondary-button" data-action="ios-install-help">iPhone install steps</button>'}
        <button class="secondary-button" data-action="export-backup">Export backup</button>
        <button class="secondary-button" data-action="import-backup">Import backup</button>
        <button class="secondary-button" data-action="print-signs">${icon('print')} Print final room signs</button>
        <button class="secondary-button" data-action="print-checklist">Print move checklist</button>
      </div>

      <section class="readiness-notes">
        <h3>Required offline rehearsal</h3>
        <p>On each phone: open the installed app online, wait for “App cached” and “Cloud synced,” then turn on Airplane Mode, fully close the app, reopen it, search for Item 2 and Piano, check in one temporary item, undo it from Checked Off, add one temporary unexpected item, and export a backup. Restore connectivity and confirm the changes appear on another phone.</p>
      </section>
    </section>`;
}

function attachGlobalHandlers(): void {
  appRoot.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const itemId = button.dataset.itemId;

    if (action === 'set-mode') {
      floatingLookupExpanded = false;
      mode = button.dataset.mode as Mode;
      if (mode === 'live' && filter === 'all' && !queryText) filter = 'remaining';
      if (mode === 'planning' && filter === 'remaining') filter = 'all';
      render();
      return;
    }
    if (action === 'set-view') {
      floatingLookupExpanded = false;
      applyViewPreset(button.dataset.view ?? 'number');
      render();
      return;
    }
    if (action === 'set-filter') {
      floatingLookupExpanded = false;
      filter = button.dataset.filter as StatusFilter;
      if (filter === 'received') {
        groupBy = 'none';
        sortBy = 'item-asc';
      }
      render();
      return;
    }
    if (action === 'toggle-floating-lookup') {
      floatingLookupExpanded = !floatingLookupExpanded;
      syncFloatingLookupUi();
      return;
    }
    if (action === 'clear-search') {
      queryText = '';
      floatingLookupExpanded = false;
      const activeSearch = isSearchInput(document.activeElement) ? document.activeElement as HTMLInputElement : undefined;
      document.querySelectorAll<HTMLInputElement>('[data-search-input]').forEach((input) => {
        input.value = '';
      });
      refreshSearchResults();
      requestAnimationFrame(() => activeSearch?.focus());
      return;
    }
    if (action === 'clear-filters') {
      clearFilters();
      render();
      return;
    }
    if (action === 'apply-app-update') {
      if (window.confirm('Reload now and apply the downloaded app update? Make sure any active item check-in is finished first.')) {
        await applyServiceWorkerUpdate?.(true);
      }
      return;
    }
    if (action === 'receive' && itemId) {
      const saved = await createEvent('RECEIVED', itemId, {});
      if (saved && 'vibrate' in navigator) navigator.vibrate?.([45, 25, 45]);
      return;
    }
    if ((action === 'undo-receipt' || action === 'unreceive') && itemId && button.dataset.receiptId) {
      if (await createEvent('RECEIPT_VOID', itemId, { receiptId: button.dataset.receiptId })) {
        animatedReceiptIds.delete(button.dataset.receiptId);
        showToast(`${itemId.startsWith('EXTRA-') ? 'Extra item' : `Item ${itemId}`} returned to Remaining`);
        if ('vibrate' in navigator) navigator.vibrate?.(30);
      }
      return;
    }
    if (action === 'issue' && itemId) {
      const note = window.prompt('Describe the missing, damaged, misplaced, or questionable piece:');
      if (note?.trim()) await createEvent('ISSUE', itemId, { note: note.trim() });
    }
    if (action === 'edit-item' && itemId) {
      mode = 'planning';
      queryText = itemId.startsWith('EXTRA-') ? `id:${itemId}` : itemId;
      groupBy = 'none';
      render();
    }
    if (action === 'save-plan' && itemId) await savePlan(itemId);
    if (action === 'bulk-route-room') await bulkRouteRoom();
    if (action === 'bulk-assign-crate') await bulkAssignCrate();
    if (action === 'open-emergency-modal') {
      editingEmergencyItemId = undefined;
      showEmergencyModal = true;
      render();
    }
    if (action === 'edit-emergency-item' && itemId) {
      editingEmergencyItemId = itemId;
      showEmergencyModal = true;
      render();
    }
    if (action === 'void-emergency-item' && itemId) {
      const reason = window.prompt('Why should this extra item be removed? Type a short reason, or Cancel to keep it:');
      if (reason?.trim()) {
        await createEvent('ITEM_VOID', itemId, { reason: reason.trim() });
        showEmergencyModal = false;
        editingEmergencyItemId = undefined;
        queryText = '';
        showToast('Accidental extra item removed');
      }
    }
    if (action === 'close-emergency-modal') {
      if (button.matches('.modal-backdrop') && target.closest('[data-modal-panel]')) return;
      showEmergencyModal = false;
      editingEmergencyItemId = undefined;
      render();
    }
    if (action === 'device-settings') {
      destinationDraft = getDestinationCatalog().map((room) => ({ ...room, originalCode: room.code }));
      showSettings = true;
      render();
    }
    if (action === 'close-settings') {
      if (button.matches('.modal-backdrop') && target.closest('[data-modal-panel]')) return;
      showSettings = false;
      destinationDraft = undefined;
      render();
    }
    if (action === 'add-destination-row') {
      destinationDraft = readDestinationDraftFromDom();
      destinationDraft.push({ code: '', label: '', active: true, originalCode: '' });
      render();
      requestAnimationFrame(() => {
        const rows = document.querySelectorAll<HTMLElement>('[data-destination-row]');
        rows.item(rows.length - 1)?.querySelector<HTMLInputElement>('[data-destination-field="code"]')?.focus();
      });
      return;
    }
    if (action === 'remove-destination-row') {
      destinationDraft = readDestinationDraftFromDom();
      const index = Number(button.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < destinationDraft.length) destinationDraft.splice(index, 1);
      render();
      return;
    }
    if (action === 'save-destination-catalog') {
      await saveDestinationCatalog();
      return;
    }
    if (action === 'save-shared-settings') await saveSharedMoveSettings();
    if (action === 'save-device-name') await saveDeviceNameFromSettings();
    if (action === 'copy-device-id') await copyDeviceId();
    if (action === 'sign-out') await signOutDevice();
    if (action === 'forget-device') await forgetDevice();
    if (action === 'install' && installPrompt) {
      await installPrompt.prompt();
      installPrompt = undefined;
      render();
    }
    if (action === 'ios-install-help') {
      window.alert('On iPhone: open the site in Safari, tap Share, choose Add to Home Screen, then launch Move Center from the new icon while still online.');
    }
    if (action === 'export-backup') await exportBackup();
    if (action === 'import-backup') document.querySelector<HTMLInputElement>('#backup-import')?.click();
    if (action === 'print-signs') printRoomSigns();
    if (action === 'print-checklist') printDayOfChecklist();
  });

  appRoot.addEventListener('toggle', (event) => {
    const details = event.target as HTMLDetailsElement;
    if (!details.matches('.bulk-panel')) return;
    bulkPlannerOpen = details.open;
  }, true);

  appRoot.addEventListener('submit', async (event) => {
    const form = event.target as HTMLFormElement;
    if (form.id === 'login-form') {
      event.preventDefault();
      const username = document.querySelector<HTMLInputElement>('#login-username')?.value ?? '';
      const password = document.querySelector<HTMLInputElement>('#login-password')?.value ?? '';
      const remember = document.querySelector<HTMLInputElement>('#remember-device')?.checked ?? true;
      loginBusy = true;
      render();
      try {
        await sync.signIn(username, password, remember);
      } catch {
        // The sync service exposes a deliberately generic error in cloudStatus.
      } finally {
        loginBusy = false;
        render();
      }
      return;
    }

    if (form.id === 'emergency-item-form') {
      event.preventDefault();
      await saveEmergencyItem(form.dataset.editingItemId || undefined);
    }
  });

  appRoot.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    const sourceId = input.dataset.sourceId ?? input.id;

    if (sourceId === 'bulk-code') {
      bulkPlannerCode = input.value.toUpperCase();
      return;
    }
    if (sourceId === 'bulk-label') {
      bulkPlannerLabel = input.value;
      return;
    }

    if (isSearchInput(input)) {
      queryText = input.value;
      floatingLookupExpanded = false;
      document.querySelectorAll<HTMLInputElement>('[data-search-input]').forEach((peer) => {
        if (peer !== input && peer.value !== queryText) peer.value = queryText;
      });
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(refreshSearchResults, 120);
      syncFloatingLookupUi();
      return;
    }

    if (sourceId === 'filter-range-from') {
      filters.rangeFrom = input.value;
      renderPreservingFocus(input.id);
    }
    if (sourceId === 'filter-range-to') {
      filters.rangeTo = input.value;
      renderPreservingFocus(input.id);
    }
  });

  appRoot.addEventListener('focusin', (event) => {
    const input = event.target as HTMLInputElement;
    if (!isSearchInput(input)) return;
    floatingLookupExpanded = false;
    syncFloatingLookupUi();
  });

  appRoot.addEventListener('focusout', (event) => {
    const input = event.target as HTMLInputElement;
    if (!isSearchInput(input) || !deferredFullRender) return;
    window.setTimeout(() => {
      if (isSearchInput(document.activeElement)) return;
      deferredFullRender = false;
      renderPreservingScroll();
    }, 180);
  });

  appRoot.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    const sourceId = input.dataset.sourceId ?? input.id;
    if (sourceId.startsWith('code-')) {
      const itemId = input.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
      if (itemId) fillRoomLabel(input.value, `#label-${safeId(itemId)}`);
      return;
    }
    if (sourceId === 'emergency-code') {
      fillRoomLabel(input.value, '#emergency-label');
      return;
    }
    if (sourceId.startsWith('keep-original-')) {
      const itemId = input.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
      if (itemId) toggleItemDestinationInputs(itemId, (input as HTMLInputElement).checked);
      return;
    }
    if (sourceId === 'bulk-room') {
      bulkPlannerSelectedRoom = input.value;
      return;
    }
    if (sourceId === 'bulk-keep-original') {
      bulkPlannerKeepOriginal = (input as HTMLInputElement).checked;
      toggleBulkDestinationInputs(bulkPlannerKeepOriginal);
      return;
    }
    if (sourceId === 'filter-room') filters.originalRoom = input.value;
    else if (sourceId === 'filter-pack') filters.packType = input.value;
    else if (sourceId === 'filter-destination') filters.destination = input.value;
    else if (sourceId === 'filter-crate') filters.crate = input.value;
    else if (sourceId === 'group-select') groupBy = input.value as GroupBy;
    else if (sourceId === 'sort-select') sortBy = input.value as SortBy;
    else return;
    render();
  });

  document.addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'backup-import' || !input.files?.[0]) return;
    await importBackup(input.files[0]);
    input.value = '';
  });
}

function applyViewPreset(view: string): void {
  if (view === 'checked') {
    filter = 'received';
    groupBy = 'none';
    sortBy = 'item-asc';
    return;
  }
  if (filter === 'received') filter = mode === 'live' ? 'remaining' : 'all';
  if (view === 'original-room') {
    groupBy = 'room';
    sortBy = 'room';
    return;
  }
  if (view === 'destination') {
    groupBy = 'destination';
    sortBy = 'destination';
    return;
  }
  groupBy = 'none';
  sortBy = 'item-asc';
}

function getDestinationCatalog(): RoomOption[] {
  return deriveDestinationCatalog(events, defaultRooms);
}

function latestDestinationCatalogEvent(): MoveEvent | undefined {
  return events
    .filter((event) => event.type === 'DESTINATIONS_UPDATE' && event.itemId === 'MOVE-DESTINATIONS')
    .sort((a, b) => a.clientAt - b.clientAt || a.id.localeCompare(b.id))
    .at(-1);
}

function readDestinationDraftFromDom(): DestinationDraftRow[] {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-destination-row]')];
  if (!rows.length) return destinationDraft ? destinationDraft.map((room) => ({ ...room })) : [];
  return rows.map((row) => ({
    code: row.querySelector<HTMLInputElement>('[data-destination-field="code"]')?.value.trim().toUpperCase() ?? '',
    label: row.querySelector<HTMLInputElement>('[data-destination-field="label"]')?.value.trim() ?? '',
    active: row.querySelector<HTMLInputElement>('[data-destination-field="active"]')?.checked ?? true,
    originalCode: row.dataset.originalCode ?? ''
  }));
}

async function saveDestinationCatalog(): Promise<void> {
  const draft = readDestinationDraftFromDom();
  const normalized = draft.map((room) => ({
    code: room.code.trim().toUpperCase(),
    label: room.label.trim(),
    active: room.active !== false,
    originalCode: room.originalCode?.trim().toUpperCase() ?? ''
  }));

  if (!normalized.length) {
    window.alert('Keep at least one destination in the shared list.');
    return;
  }
  const invalid = normalized.find((room) => !/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(room.code) || !room.label || room.label.length > 120);
  if (invalid) {
    window.alert('Every destination needs a unique code using letters, numbers, hyphens, or underscores, plus a room label.');
    return;
  }
  const codes = normalized.map((room) => room.code);
  if (new Set(codes).size !== codes.length) {
    window.alert('Destination codes must be unique.');
    return;
  }
  if (!normalized.some((room) => room.active)) {
    window.alert('At least one destination must remain visible.');
    return;
  }

  const currentCatalog = getDestinationCatalog();
  const migrate = document.querySelector<HTMLInputElement>('#migrate-destination-assignments')?.checked ?? true;
  const updates = new Map<string, RoomOption>();
  for (const room of normalized) {
    if (!room.originalCode) continue;
    const previous = currentCatalog.find((candidate) => candidate.code.toUpperCase() === room.originalCode);
    if (previous && (previous.code !== room.code || previous.label !== room.label)) {
      updates.set(previous.code.toUpperCase(), { code: room.code, label: room.label, active: room.active });
    }
  }

  const cleanCatalog: RoomOption[] = normalized.map(({ originalCode: _originalCode, ...room }) => room);
  const now = Date.now();
  const newEvents: MoveEvent[] = [{
    ...makeEvent('DESTINATIONS_UPDATE', 'MOVE-DESTINATIONS', { catalogJson: JSON.stringify(cleanCatalog) }),
    clientAt: now
  }];

  let migratedCount = 0;
  if (migrate && updates.size) {
    for (const item of getWorkingItems()) {
      const state = deriveItemState(item.itemId, events);
      if (state.keepOriginalRoom || !state.destinationCode) continue;
      const replacement = updates.get(state.destinationCode.toUpperCase());
      if (!replacement) continue;
      newEvents.push({
        ...makeEvent('PLAN_UPDATE', item.itemId, {
          assignedCrateId: effectiveCrate(item, state),
          destinationCode: replacement.code,
          destinationLabel: replacement.label,
          notes: state.notes ?? '',
          keepOriginalRoom: false
        }),
        clientAt: now + newEvents.length
      });
      migratedCount += 1;
    }
  }

  await putEvents(newEvents);
  events = await getAllEvents();
  destinationDraft = cleanCatalog.map((room) => ({ ...room, originalCode: room.code }));
  render();
  await sync.flushLocalEvents();
  showToast(`Shared destination list saved${migratedCount ? ` · ${migratedCount} routed piece${migratedCount === 1 ? '' : 's'} updated` : ''}`);
}

function toggleItemDestinationInputs(itemId: string, keepOriginal: boolean): void {
  const code = document.querySelector<HTMLInputElement>(`#code-${safeId(itemId)}`);
  const label = document.querySelector<HTMLInputElement>(`#label-${safeId(itemId)}`);
  for (const input of [code, label]) {
    if (!input) continue;
    input.disabled = keepOriginal;
    input.closest('label')?.classList.toggle('is-disabled', keepOriginal);
  }
}

function toggleBulkDestinationInputs(keepOriginal: boolean): void {
  const container = document.querySelector<HTMLElement>('#bulk-custom-destination');
  container?.classList.toggle('is-disabled', keepOriginal);
  container?.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
    input.disabled = keepOriginal;
  });
}

async function saveSharedMoveSettings(): Promise<void> {
  destinationDraft = readDestinationDraftFromDom();
  const hasCrateListing = document.querySelector<HTMLInputElement>('#shared-crate-listing')?.checked ?? false;
  if (await createEvent('SETTINGS_UPDATE', 'MOVE-SETTINGS', { hasCrateListing })) {
    normalizeCrateUiState(hasCrateListing);
    showToast(hasCrateListing ? 'Crate features enabled for every authorized device' : 'Crate features hidden for every authorized device');
  }
}

function renderPreservingFocus(id: string): void {
  const current = document.querySelector<HTMLInputElement>(`#${id}`);
  const sourceId = current?.dataset.sourceId;
  const value = current?.value ?? '';
  const selection = current?.selectionStart ?? value.length;
  render();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const replacement =
        document.querySelector<HTMLInputElement>(`#${id}`) ??
        (sourceId ? document.querySelector<HTMLInputElement>(`#${sourceId}`) : undefined);
      replacement?.focus();
      replacement?.setSelectionRange(selection, selection);
    });
  });
}

function fillRoomLabel(code: string, selector: string): void {
  const room = getDestinationCatalog().find((candidate) => candidate.code.toLowerCase() === code.trim().toLowerCase());
  if (!room) return;
  const labelInput = document.querySelector<HTMLInputElement>(selector);
  if (labelInput && !labelInput.value.trim()) labelInput.value = room.label;
}

async function createEvent(type: MoveEvent['type'], itemId: string, payload: Record<string, unknown>): Promise<boolean> {
  if (!cloudStatus.authenticated || (!cloudStatus.authorized && navigator.onLine)) {
    window.alert('Your secure session is not ready. Reconnect and sign in before making changes.');
    return false;
  }
  const moveEvent = makeEvent(type, itemId, payload);
  await putEvent(moveEvent);
  events = await getAllEvents();
  render();
  await sync.publish(moveEvent);
  return true;
}

function makeEvent(type: MoveEvent['type'], itemId: string, payload: Record<string, unknown>): MoveEvent {
  return {
    id: crypto.randomUUID(),
    moveId: moveConfig.moveId,
    type,
    itemId,
    deviceId: meta.deviceId,
    deviceName: meta.deviceName,
    actorUid: cloudStatus.user?.uid,
    actorUsername: cloudStatus.user?.username,
    clientAt: Date.now(),
    payload
  };
}

async function savePlan(itemId: string): Promise<void> {
  const item = getWorkingItems().find((candidate) => candidate.itemId === itemId);
  if (!item) return;
  const state = deriveItemState(itemId, events);
  const assignedCrateId = document.querySelector<HTMLSelectElement>(`#crate-${safeId(itemId)}`)?.value || state.assignedCrateId || 'UNASSIGNED';
  const keepOriginalRoom = document.querySelector<HTMLInputElement>(`#keep-original-${safeId(itemId)}`)?.checked ?? false;
  const code = keepOriginalRoom ? '' : (document.querySelector<HTMLInputElement>(`#code-${safeId(itemId)}`)?.value.trim().toUpperCase() ?? '');
  const room = getDestinationCatalog().find((candidate) => candidate.code.toUpperCase() === code);
  const label = keepOriginalRoom ? '' : (document.querySelector<HTMLInputElement>(`#label-${safeId(itemId)}`)?.value.trim() || room?.label || '');
  const notes = document.querySelector<HTMLTextAreaElement>(`#notes-${safeId(itemId)}`)?.value.trim() ?? '';
  if (keepOriginalRoom && !item.originalRoom?.trim()) {
    window.alert('This piece has no original room label to keep. Enter a new destination instead.');
    return;
  }
  if (!keepOriginalRoom && (!code || !label)) {
    window.alert('Enter a destination code and room label, or select Keep the original room name.');
    return;
  }
  if (await createEvent('PLAN_UPDATE', itemId, { assignedCrateId, destinationCode: code, destinationLabel: label, notes, keepOriginalRoom })) {
    showToast(`${itemId.startsWith('EXTRA-') ? 'Extra item' : `Item ${itemId}`} routing saved`);
  }
}

async function saveEmergencyItem(editingId?: string): Promise<void> {
  if (!cloudStatus.authenticated || (!cloudStatus.authorized && navigator.onLine)) {
    window.alert('Reconnect and sign in before adding an unexpected item.');
    return;
  }

  const editingItem = editingId ? getWorkingItems().find((item) => item.itemId === editingId) : undefined;
  const editingState = editingId ? deriveItemState(editingId, events) : emptyState();
  const description = document.querySelector<HTMLInputElement>('#emergency-description')?.value.trim() ?? '';
  const comments = document.querySelector<HTMLTextAreaElement>('#emergency-comments')?.value.trim() ?? '';
  const packType = document.querySelector<HTMLInputElement>('#emergency-pack')?.value.trim() || 'Unspecified package';
  const observedArea = document.querySelector<HTMLInputElement>('#emergency-area')?.value.trim() || 'Move-day addition';
  const assignedCrateId = document.querySelector<HTMLSelectElement>('#emergency-crate')?.value || editingState.assignedCrateId || editingItem?.crateId || 'UNASSIGNED';
  const destinationCode = document.querySelector<HTMLInputElement>('#emergency-code')?.value.trim().toUpperCase() ?? '';
  const room = getDestinationCatalog().find((candidate) => candidate.code.toUpperCase() === destinationCode);
  const destinationLabel = document.querySelector<HTMLInputElement>('#emergency-label')?.value.trim() || room?.label || '';
  const notes = document.querySelector<HTMLTextAreaElement>('#emergency-notes')?.value.trim() ?? '';
  const markReceived = document.querySelector<HTMLInputElement>('#emergency-received')?.checked ?? false;

  if (!description) {
    window.alert('Enter a short item name or description.');
    return;
  }

  const itemId = editingId || `EXTRA-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const detailEvent = makeEvent(editingId ? 'ITEM_EDIT' : 'ITEM_ADD', itemId, {
    description,
    comments,
    packType,
    observedArea,
    assignedCrateId,
    destinationCode,
    destinationLabel,
    notes,
    tags: createEmergencyTags(description, comments, packType, observedArea)
  });
  const newEvents: MoveEvent[] = [detailEvent];

  newEvents.push({
    ...makeEvent('PLAN_UPDATE', itemId, { assignedCrateId, destinationCode, destinationLabel, notes, keepOriginalRoom: false }),
    clientAt: detailEvent.clientAt + 1
  });

  if (!editingId && markReceived) {
    newEvents.push({ ...makeEvent('RECEIVED', itemId, {}), clientAt: detailEvent.clientAt + 2 });
  }

  await putEvents(newEvents);
  events = await getAllEvents();
  showEmergencyModal = false;
  editingEmergencyItemId = undefined;
  queryText = `id:${itemId}`;
  filter = 'all';
  groupBy = 'none';
  render();
  await sync.flushLocalEvents();
  showToast(editingId ? 'Unexpected item details updated' : `Unexpected item added${markReceived ? ' and checked in' : ''}`);
  if (!editingId && markReceived && 'vibrate' in navigator) navigator.vibrate?.([40, 30, 40]);
}

function createEmergencyTags(...values: string[]): string[] {
  const words = values
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 2);
  return [...new Set(['extra', 'unexpected', 'emergency add', 'unlisted', ...words])].slice(0, 30);
}

async function bulkRouteRoom(): Promise<void> {
  if (bulkPlannerBusy) return;
  const originalRoom = document.querySelector<HTMLSelectElement>('#bulk-room')?.value ?? bulkPlannerSelectedRoom;
  const keepOriginalRoom = document.querySelector<HTMLInputElement>('#bulk-keep-original')?.checked ?? bulkPlannerKeepOriginal;
  const rawCode = document.querySelector<HTMLInputElement>('#bulk-code')?.value ?? bulkPlannerCode;
  const rawLabel = document.querySelector<HTMLInputElement>('#bulk-label')?.value ?? bulkPlannerLabel;
  const code = keepOriginalRoom ? '' : rawCode.trim().toUpperCase();
  const roomOption = getDestinationCatalog().find((candidate) => candidate.code.toUpperCase() === code);
  const label = keepOriginalRoom ? '' : (rawLabel.trim() || roomOption?.label || '');

  bulkPlannerOpen = true;
  bulkPlannerSelectedRoom = originalRoom;
  bulkPlannerKeepOriginal = keepOriginalRoom;
  bulkPlannerCode = rawCode;
  bulkPlannerLabel = rawLabel;

  if (!originalRoom) {
    window.alert('Choose an original room.');
    return;
  }
  if (!keepOriginalRoom && (!code || !label)) {
    window.alert('Enter a destination code and room label, or select Keep original room name.');
    return;
  }
  const targets = getWorkingItems().filter((item) => item.originalRoom === originalRoom);
  const destinationDescription = keepOriginalRoom ? `keep “${originalRoom}” as the final room` : `apply ${code} (${label})`;
  if (!window.confirm(`${destinationDescription} for all ${targets.length} pieces originally listed in ${originalRoom}?`)) return;

  bulkPlannerBusy = true;
  renderPreservingElementPosition('.bulk-panel');

  const newEvents = targets.map((item, index) => {
    const state = deriveItemState(item.itemId, events);
    return {
      ...makeEvent('PLAN_UPDATE', item.itemId, {
        assignedCrateId: effectiveCrate(item, state),
        destinationCode: code,
        destinationLabel: label,
        notes: state.notes ?? '',
        keepOriginalRoom
      }),
      clientAt: Date.now() + index
    };
  });
  await saveBulkEvents(newEvents, keepOriginalRoom
    ? `Kept ${originalRoom} as the final destination for ${targets.length} pieces.`
    : `Routed ${targets.length} pieces from ${originalRoom} to ${code} · ${label}.`);
}

async function bulkAssignCrate(): Promise<void> {
  const from = Number(document.querySelector<HTMLInputElement>('#range-from')?.value);
  const to = Number(document.querySelector<HTMLInputElement>('#range-to')?.value);
  const crateId = document.querySelector<HTMLSelectElement>('#range-crate')?.value ?? '';
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > inventory.items.length || from > to || !crateId) {
    window.alert('Enter a valid Item 1–388 range and choose a crate.');
    return;
  }
  const targets = inventory.items.filter((item) => item.sequence >= from && item.sequence <= to);
  if (!window.confirm(`Assign Items ${from}-${to} (${targets.length} pieces) to ${crateId}? Use this only when supported by a current label or mover manifest.`)) return;
  const newEvents = targets.map((item, index) => {
    const state = deriveItemState(item.itemId, events);
    return {
      ...makeEvent('PLAN_UPDATE', item.itemId, {
        assignedCrateId: crateId,
        destinationCode: state.destinationCode ?? '',
        destinationLabel: state.destinationLabel ?? '',
        notes: state.notes ?? '',
        keepOriginalRoom: state.keepOriginalRoom === true
      }),
      clientAt: Date.now() + index
    };
  });
  await saveBulkEvents(newEvents, `Assigned ${targets.length} pieces to ${crateId}.`);
}

async function saveBulkEvents(newEvents: MoveEvent[], confirmation: string): Promise<void> {
  bulkSyncInProgress = true;
  bulkSyncRenderQueued = false;
  bulkPlannerOpen = true;
  let syncQueuedOffline = false;
  try {
    await putEvents(newEvents);
    events = await getAllEvents();
    toastMessage = confirmation;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastMessage = '';
      renderPreservingElementPosition('.bulk-panel');
    }, 3200);
    renderPreservingElementPosition('.bulk-panel');
    try {
      await sync.flushLocalEvents();
    } catch (error) {
      syncQueuedOffline = true;
      console.warn('Bulk room events remain saved locally and will sync after reconnecting.', error);
    }
  } finally {
    bulkSyncInProgress = false;
    bulkPlannerBusy = false;
    if (bulkSyncRenderQueued) events = await getAllEvents();
    bulkSyncRenderQueued = false;
    if (syncQueuedOffline) toastMessage = `${confirmation} Saved locally; cloud sync will retry automatically.`;
    renderPreservingElementPosition('.bulk-panel');
  }
}

async function saveDeviceNameFromSettings(): Promise<void> {
  destinationDraft = readDestinationDraftFromDom();
  const name = document.querySelector<HTMLInputElement>('#device-name-setting')?.value.trim();
  if (!name) return;
  meta = { ...meta, deviceName: name.slice(0, 80) };
  await putMeta(meta);
  showSettings = false;
  render();
}

async function copyDeviceId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(meta.deviceId);
    window.alert('Device ID copied.');
  } catch {
    window.prompt('Copy this device ID:', meta.deviceId);
  }
}

async function signOutDevice(): Promise<void> {
  if (!window.confirm('Sign out of Move Command Center on this device? The local offline cache will remain, but it stays locked behind the login screen.')) return;
  showSettings = false;
  await sync.signOut();
  render();
}

async function forgetDevice(): Promise<void> {
  const confirmation = window.prompt('This erases the cached inventory, device ID, and unsynced local events from this device. Type ERASE to continue:');
  if (confirmation !== 'ERASE') return;
  try {
    await sync.forgetDeviceData();
  } catch {
    window.alert('Close any other tabs using this site, then try clearing this device again.');
    return;
  }
  await clearLocalData();
  inventory = emptyInventoryBundle();
  physicalCrates = [];
  inventoryCached = false;
  events = [];
  meta = { deviceId: crypto.randomUUID(), deviceName: suggestedDeviceName() };
  await putMeta(meta);
  showSettings = false;
  window.location.reload();
}

async function exportBackup(): Promise<void> {
  const workingItems = getWorkingItems();
  const payload = {
    backupVersion: 5,
    moveId: moveConfig.moveId,
    exportedAt: new Date().toISOString(),
    inventoryVersion: inventory.metadata.version,
    baseInventoryItemCount: inventory.items.length,
    workingItemCount: workingItems.length,
    device: meta,
    authenticatedUsername: cloudStatus.user?.username,
    events: await getAllEvents()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const fileName = `move-command-center-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const file = new File([blob], fileName, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ title: 'Move Command Center backup', files: [file] });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importBackup(file: File): Promise<void> {
  try {
    const parsed = JSON.parse(await file.text()) as {
      moveId?: string;
      baseInventoryItemCount?: number;
      inventoryItemCount?: number;
      events?: MoveEvent[];
    };
    if (parsed.moveId !== moveConfig.moveId) throw new Error('This backup belongs to a different move.');
    const baseCount = parsed.baseInventoryItemCount ?? parsed.inventoryItemCount;
    if (baseCount && baseCount !== inventory.items.length) throw new Error('This backup uses a different master inventory item count.');
    if (!Array.isArray(parsed.events)) throw new Error('Backup does not contain an event list.');
    await putEvents(parsed.events);
    events = await getAllEvents();
    render();
    await sync.flushLocalEvents();
    window.alert(`Imported ${parsed.events.length} event records.`);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Backup import failed.');
  }
}

function printRoomSigns(): void {
  const workingItems = getWorkingItems();
  const routed = workingItems.map((item) => ({ item, state: deriveItemState(item.itemId, events) }));
  const unrouted = routed.filter(({ item, state }) => !hasDestination(item, state));
  if (unrouted.length) {
    const firstFew = unrouted.slice(0, 8).map(({ item }) => displayItemId(item)).join(', ');
    window.alert(`Room signs are not ready yet. ${unrouted.length} item${unrouted.length === 1 ? '' : 's'} still need a final destination${firstFew ? ` (${firstFew}${unrouted.length > 8 ? ', …' : ''})` : ''}. Finish routing everything, then print again.`);
    return;
  }

  const used = new Map<string, { code: string; label: string; count: number }>();
  for (const { item, state } of routed) {
    const destination = finalDestination(item, state);
    if (!destination) continue;
    const key = `${destination.code.toUpperCase()}|${normalizeForSort(destination.label)}`;
    const existing = used.get(key);
    if (existing) existing.count += 1;
    else used.set(key, { code: destination.code, label: destination.label, count: 1 });
  }
  if (!used.size) {
    window.alert('No final room destinations are currently in use.');
    return;
  }

  const pages = [...used.values()]
    .sort((a, b) => compareText(a.label, b.label) || compareText(a.code, b.code))
    .map(({ code, label, count }) => `
      <section class="sign-page">
        ${code ? `<div class="sign-code">${escapeHtml(code)}</div>` : ''}
        <div class="sign-label">${escapeHtml(label)}</div>
        <div class="sign-count">${count} item${count === 1 ? '' : 's'} routed here</div>
      </section>
    `).join('');
  openPrintWindow('Final Room Signs', pages, `
    .sign-page{height:95vh;display:flex;flex-direction:column;align-items:center;justify-content:center;page-break-after:always;border:12px solid #000;box-sizing:border-box;padding:40px}
    .sign-code{font:900 170px/1 Arial,sans-serif;text-align:center}.sign-label{font:800 52px/1.15 Arial,sans-serif;text-align:center;margin-top:26px}.sign-count{font:700 18px/1.3 Arial,sans-serif;margin-top:30px;color:#444}
  `);
}

function printDayOfChecklist(): void {
  const crateStep = crateFeaturesEnabled()
    ? '<li>Confirm all current crates are empty using the reliable mover-provided crate listing.</li>'
    : '';
  const body = `
    <h1>Move Day Command Checklist</h1>
    <h2>Before truck arrival</h2>
    <ol><li>Open the installed app on every phone while online.</li><li>Confirm App cached, Cloud synced, and the correct device name.</li><li>Export one fresh backup.</li><li>Place room signs and directional arrows.</li><li>Keep one charger and power bank at the inventory check-in station.</li></ol>
    <h2>During unloading</h2>
    <ol><li>Start in Number List. A spoken “2” returns only Item 2.</li><li>Switch between Number List, Original Rooms, and New Rooms with the quick-view buttons.</li><li>Use descriptions, comments, package types, rooms, or destination codes when the number is unclear.</li><li>Call out the large destination shown on the exact item card.</li><li>Tap Check in item only after it is physically accounted for.</li><li>Use the ten-second Undo row for immediate mistakes, or Checked Off to uncheck anything later.</li><li>Use Add unexpected item when no master-list record can be found.</li><li>Use Log issue for missing, damaged, mismatched, or unclear pieces.</li></ol>
    <h2>Before truck departure</h2>
    <ol><li>Open Remaining and inspect every result.</li><li>Open Checked Off and confirm the completed list.</li><li>Review Issues and Extras with the crew lead.</li>${crateStep}<li>Check the truck and staging areas before signing delivery completion.</li><li>Export a final backup and reconnect every phone.</li></ol>
  `;
  openPrintWindow('Move Checklist', body, 'body{font:18px/1.5 Arial,sans-serif;max-width:800px;margin:40px auto}h1{font-size:34px}h2{margin-top:32px}li{margin:12px 0}');
}

function openPrintWindow(title: string, body: string, css: string): void {
  const popup = window.open('', '_blank');
  if (!popup) {
    window.alert('Allow pop-ups temporarily to print.');
    return;
  }
  popup.document.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>${css}@media print{button{display:none}}</style></head><body>${body}<button onclick="window.print()">Print</button></body></html>`);
  popup.document.close();
}

function passesFilters(item: InventoryItem, state: DerivedItemState): boolean {
  if (filter === 'remaining' && state.received && !(mode === 'live' && isReceiptInGrace(state))) return false;
  if (filter === 'received' && !state.received) return false;
  if (filter === 'issues' && state.issueCount === 0) return false;
  if (filter === 'no-destination' && hasDestination(item, state)) return false;
  if (filter === 'no-crate' && effectiveCrate(item, state) !== 'UNASSIGNED') return false;
  if (filter === 'high-value' && !isHighValue(item)) return false;
  if (filter === 'extra' && !item.isAdHoc) return false;

  if (filters.originalRoom !== 'ALL' && (item.originalRoom || '') !== filters.originalRoom) return false;
  if (filters.packType !== 'ALL' && (item.originalCode || '') !== filters.packType) return false;
  if (filters.destination !== 'ALL' && destinationFilterKey(item, state) !== filters.destination) return false;
  if (filters.crate !== 'ALL' && effectiveCrate(item, state) !== filters.crate) return false;

  const from = filters.rangeFrom ? Number(filters.rangeFrom) : undefined;
  const to = filters.rangeTo ? Number(filters.rangeTo) : undefined;
  if (from !== undefined || to !== undefined) {
    const numericId = /^\d+$/.test(item.itemId) ? Number(item.itemId) : undefined;
    if (numericId === undefined) return false;
    if (from !== undefined && numericId < from) return false;
    if (to !== undefined && numericId > to) return false;
  }

  return true;
}

function sortEntries(entries: VisibleItem[]): VisibleItem[] {
  return [...entries].sort((a, b) => {
    if (sortBy === 'relevance' && queryText.trim()) {
      return b.match.score - a.match.score || compareItemIds(a.item, b.item);
    }
    if (sortBy === 'item-desc') return compareItemIds(b.item, a.item);
    if (sortBy === 'room') return compareText(a.item.originalRoom, b.item.originalRoom) || compareItemIds(a.item, b.item);
    if (sortBy === 'pack') return compareText(a.item.originalCode, b.item.originalCode) || compareItemIds(a.item, b.item);
    if (sortBy === 'destination') return compareText(destinationFilterKey(a.item, a.state), destinationFilterKey(b.item, b.state)) || compareItemIds(a.item, b.item);
    if (sortBy === 'updated') return latestActivity(b.item.itemId) - latestActivity(a.item.itemId) || compareItemIds(a.item, b.item);
    if (sortBy === 'relevance') return compareItemIds(a.item, b.item);
    return compareItemIds(a.item, b.item);
  });
}

function compareItemIds(a: InventoryItem, b: InventoryItem): number {
  const aNumeric = /^\d+$/.test(a.itemId) ? Number(a.itemId) : Number.POSITIVE_INFINITY;
  const bNumeric = /^\d+$/.test(b.itemId) ? Number(b.itemId) : Number.POSITIVE_INFINITY;
  return aNumeric - bNumeric || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.itemId.localeCompare(b.itemId);
}

function compareText(a: unknown, b: unknown): number {
  return normalizeForSort(a).localeCompare(normalizeForSort(b), undefined, { numeric: true });
}

function latestActivity(itemId: string): number {
  return events.filter((event) => event.itemId === itemId).reduce((latest, event) => Math.max(latest, event.clientAt), 0);
}

function effectiveCrate(item: InventoryItem, state: DerivedItemState): string {
  return state.assignedCrateId || item.crateId || 'UNASSIGNED';
}

function isHighValue(item: InventoryItem): boolean {
  return item.sourceFields['High Value'] === true;
}

function finalDestination(item: InventoryItem, state: DerivedItemState): { code: string; label: string; text: string; keptOriginal: boolean } | undefined {
  if (state.keepOriginalRoom && item.originalRoom?.trim()) {
    const label = item.originalRoom.trim();
    const matchingRoom = getDestinationCatalog().find((room) => normalizeForSort(room.label) === normalizeForSort(label));
    const code = matchingRoom?.code ?? '';
    return {
      code,
      label,
      text: code ? `${code} · ${label}` : label,
      keptOriginal: true
    };
  }
  if (state.destinationCode || state.destinationLabel) {
    const code = state.destinationCode ?? '';
    const label = state.destinationLabel ?? '';
    return {
      code,
      label,
      text: code ? `${code}${label ? ` · ${label}` : ''}` : label,
      keptOriginal: false
    };
  }
  return undefined;
}

function hasDestination(item: InventoryItem, state: DerivedItemState): boolean {
  return Boolean(finalDestination(item, state));
}

function destinationText(item: InventoryItem, state: DerivedItemState): string {
  return finalDestination(item, state)?.text ?? 'HOLD · Destination not assigned';
}

function destinationFilterKey(item: InventoryItem, state: DerivedItemState): string {
  return finalDestination(item, state)?.text ?? 'UNASSIGNED';
}

function getOriginalRooms(items: InventoryItem[]): string[] {
  return [...new Set(items.map((item) => item.originalRoom).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
}

function getPackTypes(items: InventoryItem[]): string[] {
  return [...new Set(items.map((item) => item.originalCode).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function getDestinations(items: InventoryItem[], states: Map<string, DerivedItemState>): string[] {
  return [...new Set(items.map((item) => destinationFilterKey(item, states.get(item.itemId) ?? emptyState())))]
    .sort((a, b) => a.localeCompare(b));
}

function countActiveFilters(): number {
  return [
    filters.originalRoom !== 'ALL',
    filters.packType !== 'ALL',
    filters.destination !== 'ALL',
    crateFeaturesEnabled() && filters.crate !== 'ALL',
    Boolean(filters.rangeFrom),
    Boolean(filters.rangeTo),
    groupBy !== 'none',
    sortBy !== 'item-asc'
  ].filter(Boolean).length;
}

function clearFilters(): void {
  filter = mode === 'live' ? 'remaining' : 'all';
  groupBy = 'none';
  sortBy = 'item-asc';
  filters = {
    originalRoom: 'ALL',
    packType: 'ALL',
    destination: 'ALL',
    crate: 'ALL',
    rangeFrom: '',
    rangeTo: ''
  };
}

function selectOptions(
  values: string[],
  selected: string,
  allLabel: string,
  labeler: (value: string) => string = (value) => value
): string {
  return values.map((value) => {
    const label = value === 'ALL' ? allLabel : labeler(value);
    return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function crateOptionLabel(value: string): string {
  if (value === 'UNASSIGNED') return 'No current crate mapped';
  return inventory.crates.find((crate) => crate.crateId === value)?.displayName ?? value;
}

function groupSelectOptions(): string {
  const options: Array<[GroupBy, string]> = [
    ['none', 'Number list / no grouping'],
    ['room', 'Original room'],
    ['pack', 'Package type'],
    ['destination', 'New destination'],
    ...(crateFeaturesEnabled() ? [['crate', 'Current delivery crate'] as [GroupBy, string]] : [])
  ];
  return options.map(([value, label]) => `<option value="${value}" ${groupBy === value ? 'selected' : ''}>${label}</option>`).join('');
}

function sortSelectOptions(): string {
  const options: Array<[SortBy, string]> = [
    ['relevance', 'Search relevance'],
    ['item-asc', 'Item number: 1 → 388'],
    ['item-desc', 'Item number: 388 → 1'],
    ['room', 'Original room'],
    ['pack', 'Package type'],
    ['destination', 'New destination'],
    ['updated', 'Most recently changed']
  ];
  return options.map(([value, label]) => `<option value="${value}" ${sortBy === value ? 'selected' : ''}>${label}</option>`).join('');
}

function showToast(message: string): void {
  toastMessage = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMessage = '';
    render();
  }, 2600);
  render();
}

function readinessCheck(label: string, ready: boolean, detail: string): string {
  return `<div class="readiness-check ${ready ? 'ready' : 'not-ready'}" data-ready="${ready}"><span class="check-icon">${ready ? '✓' : '!'}</span><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></div></div>`;
}

function renderMoveProgressHero(counts: CountSummary): string {
  const isLive = mode === 'live';
  const completed = isLive ? counts.received : counts.destinationAssigned;
  const progress = percent(completed, counts.total);
  const label = isLive ? 'Live unload progress' : 'Planning progress';
  const detail = isLive
    ? `${completed} of ${counts.total} pieces checked in`
    : `${completed} of ${counts.total} pieces have a final room`;
  return `
    <section class="move-progress-hero ${isLive ? 'live-progress' : 'planning-progress'}">
      <div class="move-progress-copy">${icon('progress')}<div><span>${escapeHtml(label)}</span><strong>${progress}%</strong><small>${escapeHtml(detail)}</small></div></div>
      <div class="move-progress-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>
    </section>`;
}

function percent(value: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function metric(label: string, value: number, detail: string, tone: 'green' | 'amber' | 'blue' | 'red' | 'slate', progress: number, iconName: string): string {
  return `<div class="metric metric-${tone}"><div class="metric-heading">${icon(iconName)}<span>${escapeHtml(label)}</span></div><strong>${value}</strong><small>${escapeHtml(detail)}</small><div class="metric-progress" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div></div>`;
}

function modeButton(value: Mode, iconName: string, label: string): string {
  return `<button data-action="set-mode" data-mode="${value}" class="${mode === value ? 'active' : ''}">${icon(iconName)}<span>${label}</span></button>`;
}

function viewPresetButton(value: string, iconName: string, label: string, active: boolean): string {
  return `<button data-action="set-view" data-view="${escapeHtml(value)}" class="${active ? 'active' : ''}">${icon(iconName)}<span>${escapeHtml(label)}</span></button>`;
}

function filterButton(value: StatusFilter, label: string): string {
  const icons: Partial<Record<StatusFilter, string>> = {
    all: 'list',
    remaining: 'box',
    received: 'history',
    issues: 'alert',
    'no-destination': 'destination',
    'high-value': 'shield',
    extra: 'add'
  };
  const iconName = icons[value];
  return `<button data-action="set-filter" data-filter="${value}" class="${filter === value ? 'active' : ''}">${iconName ? icon(iconName) : ''}<span>${escapeHtml(label)}</span></button>`;
}

function statusPill(label: string, tone: 'ok' | 'warn' | 'neutral'): string {
  return `<span class="status-pill ${tone}">${escapeHtml(label)}</span>`;
}

function cloudLabel(): string {
  if (!cloudStatus.enabled) return 'Setup required';
  if (!cloudStatus.authenticated) return 'Signed out';
  if (cloudStatus.lastError && navigator.onLine) return 'Sync error';
  if (!navigator.onLine) return 'Offline ready';
  if (cloudStatus.authorized && cloudStatus.snapshotLoaded) return 'Cloud synced';
  if (cloudStatus.authorized) return 'Connecting sync';
  return 'Checking access';
}

function cloudTone(): 'ok' | 'warn' | 'neutral' {
  if (!cloudStatus.enabled || (!cloudStatus.authenticated && cloudStatus.authReady)) return 'warn';
  if (cloudStatus.lastError && navigator.onLine) return 'warn';
  if (!navigator.onLine && cloudStatus.authenticated && inventoryCached) return 'ok';
  if (cloudStatus.authorized && cloudStatus.snapshotLoaded) return 'ok';
  return 'neutral';
}

function emptyState(): DerivedItemState {
  return { received: false, issueCount: 0 };
}

function suggestedDeviceName(): string {
  const platform = navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Device';
  return `${platform} ${Math.floor(Math.random() * 900 + 100)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function displayItemId(item?: InventoryItem): string {
  if (!item) return 'Item';
  if (item.isAdHoc) return `EXTRA · ${item.itemId.slice(-6)}`;
  return `ITEM ${Number(item.itemId)}`;
}

function icon(name: string): string {
  return `<img class="ui-icon" src="./icons/ui/${escapeHtml(name)}.svg" alt="" aria-hidden="true" />`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character] ?? character);
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function getAppRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('App root not found.');
  return root;
}
