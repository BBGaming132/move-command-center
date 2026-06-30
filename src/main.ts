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
import { deriveItemState, findUndoableReceipt } from './lib/events';
import { createSearchText, matchesSearch } from './lib/search';
import { FirebaseSync } from './lib/firebase-sync';

const rooms = roomJson as RoomOption[];
const appRoot = getAppRoot();

let inventory: InventoryBundle = emptyInventoryBundle();
let physicalCrates = inventory.crates.filter((crate) => crate.isPhysical !== false);
let inventoryCached = false;

type Mode = 'live' | 'planning' | 'readiness';
type StatusFilter = 'all' | 'remaining' | 'received' | 'issues' | 'no-destination' | 'no-crate' | 'high-value';
type GroupBy = 'room' | 'crate';

let mode: Mode = 'readiness';
let filter: StatusFilter = 'all';
let groupBy: GroupBy = 'room';
let queryText = '';
let events: MoveEvent[] = [];
let meta: AppMeta = { deviceId: crypto.randomUUID(), deviceName: 'Unassigned device' };
let localDbReady = false;
let serviceWorkerReady = false;
let updateAvailable = false;
let searchTimer: number | undefined;
let loginBusy = false;
let showSettings = false;
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

const sync = new FirebaseSync({
  onEvents: async () => {
    events = await getAllEvents();
    render();
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
    render();
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

  registerSW({
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
    onRegisterError(error) {
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

  attachGlobalHandlers();
  render();
  await sync.start();
}

function render(): void {
  if (!cloudStatus.enabled) {
    appRoot.innerHTML = renderSetupGate();
    return;
  }
  if (!cloudStatus.authReady) {
    appRoot.innerHTML = renderSecureLoading('Restoring the saved device session…');
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
    return;
  }
  if (!accessGranted) {
    appRoot.innerHTML = cloudStatus.lastError
      ? renderAccessDenied()
      : renderSecureLoading('Checking this account’s move access…');
    return;
  }
  if (!inventoryCached || inventory.items.length === 0) {
    appRoot.innerHTML = renderSecureLoading(
      navigator.onLine
        ? 'Downloading the private 388-piece inventory to this device…'
        : 'This device has not downloaded the inventory yet. Connect once, then reopen the app.'
    );
    return;
  }

  const states = buildStates();
  const visibleItems = inventory.items.filter((item) => isVisible(item, states.get(item.itemId) ?? emptyState()));
  const counts = calculateCounts(states);

  appRoot.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Private household move</p>
          <h1>${escapeHtml(moveConfig.title)}</h1>
        </div>
        <button class="icon-button" data-action="device-settings" aria-label="Device and account settings">⚙</button>
      </header>

      ${updateAvailable ? '<div class="banner warning">An update is available. Do not reload during active unloading; apply it only during a safe pause.</div>' : ''}
      ${inventory.metadata.status !== 'verified' ? '<div class="banner danger">The inventory is not verified, so live receiving is locked.</div>' : ''}
      ${inventory.metadata.crateMappingStatus === 'not-provided-in-source' ? '<div class="banner info">The PDF verifies all 388 pieces but does not say which crate contains each piece. Use Original Room grouping now, and assign current crate numbers only when labels or manifests become known.</div>' : ''}

      <section class="status-strip" aria-label="System status">
        ${statusPill(navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? 'ok' : 'neutral')}
        ${statusPill(serviceWorkerReady ? 'App cached' : 'Caching app', serviceWorkerReady ? 'ok' : 'warn')}
        ${statusPill(cloudLabel(), cloudTone())}
        ${statusPill(`@${cloudStatus.user?.username ?? 'user'}`, 'ok')}
        ${statusPill(meta.deviceName, 'neutral')}
      </section>

      <nav class="mode-tabs" aria-label="App mode">
        ${modeButton('live', 'Live Move')}
        ${modeButton('planning', 'Planning')}
        ${modeButton('readiness', 'Readiness')}
      </nav>

      ${mode === 'readiness' ? renderReadiness(counts) : renderWorkMode(visibleItems, states, counts)}

      <footer>
        <span>Inventory ${escapeHtml(inventory.metadata.version)}</span>
        <span>${physicalCrates.length} current crates · ${inventory.items.length} verified pieces</span>
      </footer>
    </div>
    <input id="backup-import" type="file" accept="application/json,.json" hidden />
    <datalist id="room-options">
      ${rooms.filter((room) => room.active).map((room) => `<option value="${escapeHtml(room.code)}">${escapeHtml(room.label)}</option>`).join('')}
    </datalist>
    ${showSettings ? renderSettingsModal() : ''}
  `;
}

function renderSetupGate(): string {
  return `
    <main class="secure-gate">
      <section class="secure-card">
        <div class="secure-mark">🔒</div>
        <p class="eyebrow">Setup required</p>
        <h1>${escapeHtml(moveConfig.title)}</h1>
        <p>Firebase is not configured in <code>src/config/firebase.config.ts</code>. The private inventory is intentionally not bundled into the public website.</p>
        <p class="secure-note">Complete the v0.3.0 Firebase bootstrap, deploy the rules, and rebuild the site.</p>
      </section>
    </main>`;
}

function renderSecureLoading(message: string): string {
  return `
    <main class="secure-gate">
      <section class="secure-card">
        <div class="secure-mark">🔐</div>
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
        <div class="secure-mark">🔒</div>
        <p class="eyebrow">Private family access</p>
        <h1>${escapeHtml(moveConfig.title)}</h1>
        <p>Sign in once on this phone before move day. With “Keep me signed in” selected, the saved session and device ID remain available after closing the app and while offline.</p>
        <form id="login-form" class="login-form" autocomplete="on">
          <label><span>Username</span><input id="login-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required /></label>
          <label><span>Password</span><input id="login-password" name="password" type="password" autocomplete="current-password" required /></label>
          <label class="remember-row"><input id="remember-device" type="checkbox" ${true ? 'checked' : ''} /><span>Keep me signed in on this device</span></label>
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
        <div class="secure-mark">⛔</div>
        <p class="eyebrow">Access blocked</p>
        <h1>${escapeHtml(moveConfig.title)}</h1>
        <div class="banner danger">${escapeHtml(cloudStatus.lastError ?? 'This account is not authorized for this move.')}</div>
        <button class="secondary-button" data-action="sign-out">Return to sign in</button>
      </section>
    </main>`;
}

function renderSettingsModal(): string {
  const user = cloudStatus.user;
  return `
    <div class="modal-backdrop" data-action="close-settings">
      <section class="settings-modal" role="dialog" aria-modal="true" aria-label="Device and account settings" data-modal-panel>
        <div class="modal-header"><div><p class="eyebrow">Device and account</p><h2>Move access</h2></div><button class="icon-button" data-action="close-settings" aria-label="Close">×</button></div>
        <dl class="settings-list">
          <dt>Signed in</dt><dd>@${escapeHtml(user?.username ?? '')}</dd>
          <dt>Device name</dt><dd>${escapeHtml(meta.deviceName)}</dd>
          <dt>Device ID</dt><dd><code>${escapeHtml(meta.deviceId)}</code></dd>
          <dt>Session</dt><dd>Saved locally until you explicitly sign out</dd>
        </dl>
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

function setInventory(bundle: InventoryBundle): void {
  inventory = bundle;
  physicalCrates = inventory.crates.filter((crate) => crate.isPhysical !== false);
  if (mode === 'readiness' && inventory.metadata.status === 'verified') mode = 'live';
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

function buildStates(): Map<string, DerivedItemState> {
  return new Map(inventory.items.map((item) => [item.itemId, deriveItemState(item.itemId, events)]));
}

function calculateCounts(states: Map<string, DerivedItemState>): CountSummary {
  const total = inventory.items.length;
  const received = inventory.items.filter((item) => states.get(item.itemId)?.received).length;
  const issues = inventory.items.reduce((sum, item) => sum + (states.get(item.itemId)?.issueCount ?? 0), 0);
  const destinationAssigned = inventory.items.filter((item) => Boolean(states.get(item.itemId)?.destinationCode)).length;
  const crateAssigned = inventory.items.filter((item) => effectiveCrate(item, states.get(item.itemId) ?? emptyState()) !== 'UNASSIGNED').length;
  const highValue = inventory.items.filter(isHighValue).length;
  return { total, received, issues, destinationAssigned, crateAssigned, highValue };
}

function renderWorkMode(
  visibleItems: InventoryItem[],
  states: Map<string, DerivedItemState>,
  counts: CountSummary
): string {
  const groups = buildGroups(visibleItems, states);
  return `
    <section class="dashboard-grid">
      ${metric('Received', counts.received, counts.total ? `${Math.round((counts.received / counts.total) * 100)}%` : '0%')}
      ${metric('Remaining', Math.max(0, counts.total - counts.received), 'pieces')}
      ${metric('Destinations', counts.destinationAssigned, `${counts.total - counts.destinationAssigned} left`)}
      ${metric('Issues', counts.issues, counts.issues ? 'review' : 'clear')}
    </section>

    ${mode === 'planning' ? renderBulkTools() : ''}

    <section class="controls sticky-controls">
      <label class="search-box">
        <span>Search every field</span>
        <input id="search-input" type="search" value="${escapeHtml(queryText)}" placeholder="Item 127, serial, room, piano, crate…" autocomplete="off" inputmode="search" />
      </label>
      <div class="control-label">Group results by</div>
      <div class="filter-row compact">
        ${groupButton('room', 'Original room')}
        ${groupButton('crate', 'Current crate')}
      </div>
      <div class="filter-row">
        ${filterButton('all', 'All')}
        ${filterButton('remaining', 'Remaining')}
        ${filterButton('received', 'Received')}
        ${filterButton('issues', 'Issues')}
        ${filterButton('no-destination', 'No destination')}
        ${filterButton('no-crate', 'No crate')}
        ${filterButton('high-value', 'High value')}
      </div>
    </section>

    <section class="crate-list">
      ${groups.map((group) => renderGroup(group, states)).join('')}
      ${visibleItems.length === 0 ? '<div class="empty-state">No pieces match the current search and filter.</div>' : ''}
    </section>
  `;
}

function buildGroups(items: InventoryItem[], states: Map<string, DerivedItemState>): ItemGroup[] {
  const map = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const state = states.get(item.itemId) ?? emptyState();
    const key = groupBy === 'room' ? (item.originalRoom || 'Original room unknown') : effectiveCrate(item, state);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }

  if (groupBy === 'crate') {
    return inventory.crates
      .map((crate) => ({
        key: crate.crateId,
        title: crate.displayName,
        subtitle: crate.originalLabel || crate.crateId,
        items: map.get(crate.crateId) ?? []
      }))
      .filter((group) => group.items.length > 0 || (!queryText && filter === 'all'));
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupItems]) => ({
      key,
      title: key,
      subtitle: 'Original 2024 room label',
      items: groupItems.sort((a, b) => a.sequence - b.sequence)
    }));
}

function renderGroup(group: ItemGroup, states: Map<string, DerivedItemState>): string {
  const received = group.items.filter((item) => states.get(item.itemId)?.received).length;
  const assigned = group.items.filter((item) => states.get(item.itemId)?.destinationCode).length;
  const open = Boolean(queryText) || filter !== 'all';
  return `
    <details class="crate" ${open ? 'open' : ''}>
      <summary>
        <div>
          <strong>${escapeHtml(group.title)}</strong>
          <span>${escapeHtml(group.subtitle)} · ${assigned}/${group.items.length} routed</span>
        </div>
        <div class="crate-progress">${received}/${group.items.length}</div>
      </summary>
      <div class="crate-items">
        ${group.items.length ? group.items.map((item) => renderItem(item, states.get(item.itemId) ?? emptyState())).join('') : '<div class="empty-inline">No pieces assigned here yet.</div>'}
      </div>
    </details>
  `;
}

function renderItem(item: InventoryItem, state: DerivedItemState): string {
  const destination = state.destinationCode
    ? `${state.destinationCode}${state.destinationLabel ? ` · ${state.destinationLabel}` : ''}`
    : 'Destination not assigned';
  const crateId = effectiveCrate(item, state);
  const crate = inventory.crates.find((candidate) => candidate.crateId === crateId);
  const comments = String(item.sourceFields.Comments ?? '');
  const content = String(item.sourceFields.Content ?? item.description);
  const receivedLabel = state.received
    ? `Received${state.receivedBy ? ` by ${state.receivedBy}` : ''}${state.receivedByUsername ? ` (@${state.receivedByUsername})` : ''}${state.receivedAt ? ` · ${formatTime(state.receivedAt)}` : ''}`
    : 'Mark received';

  return `
    <article class="item-card ${state.received ? 'is-received' : ''}" data-item-id="${escapeHtml(item.itemId)}">
      <div class="item-topline">
        <div>
          <span class="item-id">ITEM ${escapeHtml(item.itemId)}</span>
          <span class="sequence">PDF p.${item.sourcePage ?? '?'}</span>
        </div>
        <div class="badge-row">
          ${isHighValue(item) ? '<span class="high-value-badge">HIGH VALUE</span>' : ''}
          ${state.issueCount ? `<span class="issue-badge">${state.issueCount} issue${state.issueCount === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
      <h3>${escapeHtml(content)}</h3>
      ${comments ? `<p class="item-description">${escapeHtml(comments)}</p>` : ''}
      <div class="routing-row">
        <div class="destination ${state.destinationCode ? '' : 'missing'}">${escapeHtml(destination)}</div>
        <div class="crate-chip ${crateId === 'UNASSIGNED' ? 'missing' : ''}">${escapeHtml(crate?.displayName ?? crateId)}</div>
      </div>
      <div class="metadata-row">
        ${item.originalRoom ? `<span>Original: ${escapeHtml(item.originalRoom)}</span>` : ''}
        ${item.originalCode ? `<span>Pack: ${escapeHtml(item.originalCode)}</span>` : ''}
        <span>Packer: ${escapeHtml(String(item.sourceFields.Packer ?? ''))}</span>
      </div>
      ${state.notes ? `<p class="notes">${escapeHtml(state.notes)}</p>` : ''}
      ${state.latestIssue ? `<p class="issue-note">Latest issue: ${escapeHtml(state.latestIssue)}</p>` : ''}

      ${mode === 'live' ? renderLiveActions(item, state, receivedLabel) : renderPlanningActions(item, state)}

      <details class="source-details">
        <summary>Complete source record and search tags</summary>
        <p>${escapeHtml(item.rawLine)}</p>
        <dl>${Object.entries(item.sourceFields).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value ?? ''))}</dd>`).join('')}</dl>
        <p class="tags">${item.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</p>
      </details>
    </article>
  `;
}

function renderLiveActions(item: InventoryItem, state: DerivedItemState, receivedLabel: string): string {
  const locked = inventory.metadata.status !== 'verified' && moveConfig.requireVerifiedInventoryForLiveMode;
  const undo = findUndoableReceipt(item.itemId, events);
  return `
    <div class="live-actions">
      <button class="receive-button ${state.received ? 'complete' : ''}" data-action="receive" data-item-id="${escapeHtml(item.itemId)}" ${state.received || locked ? 'disabled' : ''}>
        ${state.received ? '✓ ' : ''}${escapeHtml(receivedLabel)}
      </button>
      ${undo ? `<button class="secondary-button" data-action="undo-receipt" data-item-id="${escapeHtml(item.itemId)}" data-receipt-id="${escapeHtml(undo.id)}">Undo accidental tap</button>` : ''}
      <button class="secondary-button" data-action="issue" data-item-id="${escapeHtml(item.itemId)}">Log issue</button>
      <button class="secondary-button" data-action="edit-item" data-item-id="${escapeHtml(item.itemId)}">Edit routing</button>
    </div>
  `;
}

function renderPlanningActions(item: InventoryItem, state: DerivedItemState): string {
  const crateId = effectiveCrate(item, state);
  return `
    <div class="planning-form">
      <label>
        <span>Current crate</span>
        <select id="crate-${safeId(item.itemId)}">
          ${inventory.crates.map((crate) => `<option value="${escapeHtml(crate.crateId)}" ${crate.crateId === crateId ? 'selected' : ''}>${escapeHtml(crate.displayName)}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>Destination code</span>
        <input id="code-${safeId(item.itemId)}" list="room-options" value="${escapeHtml(state.destinationCode ?? '')}" placeholder="A, B, KITCHEN…" />
      </label>
      <label>
        <span>Destination label</span>
        <input id="label-${safeId(item.itemId)}" value="${escapeHtml(state.destinationLabel ?? '')}" placeholder="Room A / Kitchen / Garage" />
      </label>
      <label class="full-width">
        <span>Placement or handling notes</span>
        <textarea id="notes-${safeId(item.itemId)}" rows="2" placeholder="Against left wall, fragile, ask Dad…">${escapeHtml(state.notes ?? '')}</textarea>
      </label>
      <button class="primary-button full-width" data-action="save-plan" data-item-id="${escapeHtml(item.itemId)}">Save piece routing</button>
    </div>
  `;
}

function renderBulkTools(): string {
  const originalRooms = [...new Set(inventory.items.map((item) => item.originalRoom).filter(Boolean) as string[])].sort();
  return `
    <details class="bulk-panel">
      <summary>Fast planning tools</summary>
      <div class="bulk-grid">
        <section>
          <h3>Route an entire old room</h3>
          <p>Use this when most pieces from one original room share a new destination. Individual exceptions can still be changed later.</p>
          <label><span>Original room</span><select id="bulk-room">${originalRooms.map((room) => `<option>${escapeHtml(room)}</option>`).join('')}</select></label>
          <label><span>New destination code</span><input id="bulk-code" list="room-options" placeholder="A, B, STORAGE…" /></label>
          <label><span>New destination label</span><input id="bulk-label" placeholder="Room A" /></label>
          <button class="primary-button" data-action="bulk-route-room">Apply to every piece in this old room</button>
        </section>
        <section>
          <h3>Assign an item-number range to a crate</h3>
          <p>Use this only when a crate label or mover manifest gives you a reliable item range.</p>
          <div class="range-row">
            <label><span>From item</span><input id="range-from" inputmode="numeric" type="number" min="1" max="388" /></label>
            <label><span>Through item</span><input id="range-to" inputmode="numeric" type="number" min="1" max="388" /></label>
          </div>
          <label><span>Current crate</span><select id="range-crate">${physicalCrates.map((crate) => `<option value="${escapeHtml(crate.crateId)}">${escapeHtml(crate.displayName)}</option>`).join('')}</select></label>
          <button class="primary-button" data-action="bulk-assign-crate">Assign range to crate</button>
        </section>
      </div>
    </details>
  `;
}

function renderReadiness(counts: CountSummary): string {
  const ids = inventory.items.map((item) => Number(item.itemId));
  const continuousIds = ids.length === 388 && ids.every((id, index) => id === index + 1);
  const checks = [
    readinessCheck('Verified PDF inventory loaded', inventory.metadata.status === 'verified', `${inventory.items.length} pieces`),
    readinessCheck('All inventory IDs 1-388 are present once', continuousIds, continuousIds ? 'Continuous and unique' : 'Review import audit'),
    readinessCheck('All 14 current delivery crates represented', physicalCrates.length === moveConfig.expectedCrateCount, `${physicalCrates.length}/${moveConfig.expectedCrateCount}`),
    readinessCheck('Local offline database works', localDbReady, localDbReady ? 'IndexedDB ready' : 'Failed'),
    readinessCheck('App files cached', serviceWorkerReady, serviceWorkerReady ? 'Offline shell ready' : 'Open once online and reload'),
    readinessCheck('Firebase security configured', cloudStatus.enabled, cloudStatus.enabled ? 'Authentication and Firestore enabled' : 'Not configured'),
    readinessCheck('Password session restored', cloudStatus.authenticated, cloudStatus.authenticated ? `Signed in as @${cloudStatus.user?.username ?? 'user'}` : 'Sign in required'),
    readinessCheck('Account authorized for this move', cloudStatus.authorized || (!navigator.onLine && cloudStatus.user?.uid === meta.lastAuthorizedUid), cloudStatus.authorized ? 'Active move membership confirmed' : 'Offline access uses the last confirmed membership'),
    readinessCheck('Private inventory cached on this device', inventoryCached && inventory.items.length === 388, inventoryCached ? '388 pieces available offline' : 'Open online once after sign-in'),
    readinessCheck('Initial cloud snapshot loaded', cloudStatus.snapshotLoaded, cloudStatus.snapshotLoaded ? 'Shared changes downloaded' : 'Reconnect once before move day'),
    readinessCheck('Every piece has a new destination', counts.total > 0 && counts.destinationAssigned === counts.total, `${counts.destinationAssigned}/${counts.total} routed`)
  ];

  return `
    <section class="readiness-panel">
      <div class="readiness-header">
        <div><p class="eyebrow">Preflight</p><h2>Move-day readiness</h2></div>
        <div class="readiness-score">${checks.filter((check) => check.includes('data-ready="true"')).length}/${checks.length}</div>
      </div>

      <div class="source-summary">
        <strong>Verified source summary</strong>
        <span>${inventory.items.length} verified inventory pieces loaded from the private Firebase record.</span>
      </div>
      <div class="banner warning">Reconciliation required: the original paperwork records 18 storage pallets, while the current delivery is expected to arrive in 14 crates. The inventory PDF contains no item-to-pallet or item-to-crate map. Do not invent one; assign current crates only from present-day labels or mover documentation.</div>
      ${inventory.metadata.unusableSourceDocuments?.length ? `<div class="banner danger">One uploaded file could not be used: ${inventory.metadata.unusableSourceDocuments.map((doc) => `${escapeHtml(doc.fileName)} (${escapeHtml(doc.reason)})`).join(', ')}.</div>` : ''}

      <div class="check-list">${checks.join('')}</div>
      <div class="readiness-check informational"><span class="check-icon">i</span><div><strong>Current crate mapping</strong><span>${counts.crateAssigned}/${counts.total} pieces assigned. This is optional until reliable current crate information is available.</span></div></div>
      ${cloudStatus.lastError ? `<div class="banner danger">Cloud error: ${escapeHtml(cloudStatus.lastError)}</div>` : ''}

      <div class="action-grid">
        <button class="primary-button" data-action="device-settings">Device and account</button>
        ${installPrompt ? '<button class="primary-button" data-action="install">Install app</button>' : '<button class="secondary-button" data-action="ios-install-help">iPhone install steps</button>'}
        <button class="secondary-button" data-action="export-backup">Export backup</button>
        <button class="secondary-button" data-action="import-backup">Import backup</button>
        <button class="secondary-button" data-action="print-signs">Print room signs</button>
        <button class="secondary-button" data-action="print-checklist">Print move checklist</button>
      </div>

      <section class="readiness-notes">
        <h3>Required offline rehearsal</h3>
        <p>On each phone: open the installed app online, wait for “App cached” and “Cloud synced,” then turn on Airplane Mode, fully close the app, reopen it, search for Item 127 and Piano, make one test routing edit, and export a backup. Restore connectivity and confirm the edit appears on the other phone.</p>
      </section>
    </section>
  `;
}

function attachGlobalHandlers(): void {
  appRoot.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const itemId = button.dataset.itemId;

    if (action === 'set-mode') {
      mode = button.dataset.mode as Mode;
      render();
      return;
    }
    if (action === 'set-filter') {
      filter = button.dataset.filter as StatusFilter;
      render();
      return;
    }
    if (action === 'set-group') {
      groupBy = button.dataset.group as GroupBy;
      render();
      return;
    }
    if (action === 'receive' && itemId) await createEvent('RECEIVED', itemId, {});
    if (action === 'undo-receipt' && itemId && button.dataset.receiptId) {
      await createEvent('RECEIPT_VOID', itemId, { receiptId: button.dataset.receiptId });
    }
    if (action === 'issue' && itemId) {
      const note = window.prompt('Describe the missing, damaged, misplaced, or questionable piece:');
      if (note?.trim()) await createEvent('ISSUE', itemId, { note: note.trim() });
    }
    if (action === 'edit-item' && itemId) {
      mode = 'planning';
      queryText = `item ${itemId}`;
      render();
    }
    if (action === 'save-plan' && itemId) await savePlan(itemId);
    if (action === 'bulk-route-room') await bulkRouteRoom();
    if (action === 'bulk-assign-crate') await bulkAssignCrate();
    if (action === 'device-settings') { showSettings = true; render(); }
    if (action === 'close-settings') {
      if (button.matches('.modal-backdrop') && target.closest('[data-modal-panel]')) return;
      showSettings = false;
      render();
    }
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

  appRoot.addEventListener('submit', async (event) => {
    const form = event.target as HTMLFormElement;
    if (form.id !== 'login-form') return;
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
  });

  appRoot.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'search-input') return;
    queryText = input.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      render();
      requestAnimationFrame(() => {
        const replacement = document.querySelector<HTMLInputElement>('#search-input');
        replacement?.focus();
        replacement?.setSelectionRange(queryText.length, queryText.length);
      });
    }, 100);
  });

  appRoot.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.id.startsWith('code-')) return;
    const itemId = input.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
    if (!itemId) return;
    fillRoomLabel(input.value, `#label-${safeId(itemId)}`);
  });

  document.addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'backup-import' || !input.files?.[0]) return;
    await importBackup(input.files[0]);
    input.value = '';
  });
}

function fillRoomLabel(code: string, selector: string): void {
  const room = rooms.find((candidate) => candidate.code.toLowerCase() === code.trim().toLowerCase());
  if (!room) return;
  const labelInput = document.querySelector<HTMLInputElement>(selector);
  if (labelInput && !labelInput.value.trim()) labelInput.value = room.label;
}

async function createEvent(type: MoveEvent['type'], itemId: string, payload: Record<string, unknown>): Promise<void> {
  if (!cloudStatus.authenticated || (!cloudStatus.authorized && navigator.onLine)) {
    window.alert('Your secure session is not ready. Reconnect and sign in before making changes.');
    return;
  }
  const moveEvent = makeEvent(type, itemId, payload);
  await putEvent(moveEvent);
  events = await getAllEvents();
  render();
  await sync.publish(moveEvent);
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
  const state = deriveItemState(itemId, events);
  const assignedCrateId = document.querySelector<HTMLSelectElement>(`#crate-${safeId(itemId)}`)?.value || state.assignedCrateId || 'UNASSIGNED';
  const code = document.querySelector<HTMLInputElement>(`#code-${safeId(itemId)}`)?.value.trim().toUpperCase() ?? '';
  const room = rooms.find((candidate) => candidate.code.toUpperCase() === code);
  const label = document.querySelector<HTMLInputElement>(`#label-${safeId(itemId)}`)?.value.trim() || room?.label || '';
  const notes = document.querySelector<HTMLTextAreaElement>(`#notes-${safeId(itemId)}`)?.value.trim() ?? '';
  await createEvent('PLAN_UPDATE', itemId, { assignedCrateId, destinationCode: code, destinationLabel: label, notes });
}

async function bulkRouteRoom(): Promise<void> {
  const originalRoom = document.querySelector<HTMLSelectElement>('#bulk-room')?.value ?? '';
  const code = document.querySelector<HTMLInputElement>('#bulk-code')?.value.trim().toUpperCase() ?? '';
  const roomOption = rooms.find((candidate) => candidate.code.toUpperCase() === code);
  const label = document.querySelector<HTMLInputElement>('#bulk-label')?.value.trim() || roomOption?.label || '';
  if (!originalRoom || !code) {
    window.alert('Choose an original room and enter a destination code.');
    return;
  }
  const targets = inventory.items.filter((item) => item.originalRoom === originalRoom);
  if (!window.confirm(`Apply ${code}${label ? ` (${label})` : ''} to all ${targets.length} pieces originally listed in ${originalRoom}?`)) return;
  const newEvents = targets.map((item, index) => {
    const state = deriveItemState(item.itemId, events);
    return {
      ...makeEvent('PLAN_UPDATE', item.itemId, {
        assignedCrateId: effectiveCrate(item, state),
        destinationCode: code,
        destinationLabel: label,
        notes: state.notes ?? ''
      }),
      clientAt: Date.now() + index
    };
  });
  await saveBulkEvents(newEvents, `Routed ${targets.length} pieces from ${originalRoom}.`);
}

async function bulkAssignCrate(): Promise<void> {
  const from = Number(document.querySelector<HTMLInputElement>('#range-from')?.value);
  const to = Number(document.querySelector<HTMLInputElement>('#range-to')?.value);
  const crateId = document.querySelector<HTMLSelectElement>('#range-crate')?.value ?? '';
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > inventory.items.length || from > to || !crateId) {
    window.alert('Enter a valid item-number range and choose a crate.');
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
        notes: state.notes ?? ''
      }),
      clientAt: Date.now() + index
    };
  });
  await saveBulkEvents(newEvents, `Assigned ${targets.length} pieces to ${crateId}.`);
}

async function saveBulkEvents(newEvents: MoveEvent[], confirmation: string): Promise<void> {
  await putEvents(newEvents);
  events = await getAllEvents();
  render();
  await sync.flushLocalEvents();
  window.alert(confirmation);
}

async function saveDeviceNameFromSettings(): Promise<void> {
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
  const payload = {
    backupVersion: 3,
    moveId: moveConfig.moveId,
    exportedAt: new Date().toISOString(),
    inventoryVersion: inventory.metadata.version,
    inventoryItemCount: inventory.items.length,
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
    const parsed = JSON.parse(await file.text()) as { moveId?: string; inventoryItemCount?: number; events?: MoveEvent[] };
    if (parsed.moveId !== moveConfig.moveId) throw new Error('This backup belongs to a different move.');
    if (parsed.inventoryItemCount && parsed.inventoryItemCount !== inventory.items.length) throw new Error('This backup uses a different inventory item count.');
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
  const used = new Map<string, string>();
  for (const item of inventory.items) {
    const state = deriveItemState(item.itemId, events);
    if (state.destinationCode) used.set(state.destinationCode, state.destinationLabel ?? state.destinationCode);
  }
  if (used.size === 0) {
    for (const room of rooms.filter((candidate) => candidate.active)) used.set(room.code, room.label);
  }
  const pages = [...used.entries()].map(([code, label]) => `
    <section class="sign-page"><div class="sign-code">${escapeHtml(code)}</div><div class="sign-label">${escapeHtml(label)}</div></section>
  `).join('');
  openPrintWindow('Room Signs', pages, `
    .sign-page{height:95vh;display:flex;flex-direction:column;align-items:center;justify-content:center;page-break-after:always;border:12px solid #000;box-sizing:border-box}
    .sign-code{font:900 180px/1 Arial,sans-serif}.sign-label{font:700 44px/1.2 Arial,sans-serif;text-align:center;margin-top:30px}
  `);
}

function printDayOfChecklist(): void {
  const body = `
    <h1>Move Day Command Checklist</h1>
    <h2>Before truck arrival</h2>
    <ol><li>Open the installed app on every phone while online.</li><li>Confirm App cached, Cloud synced, and the correct device name.</li><li>Export one fresh backup.</li><li>Place room signs and directional arrows.</li><li>Keep one charger and power bank at the inventory check-in station.</li></ol>
    <h2>During unloading</h2>
    <ol><li>The inventory lead remains at item check-in with the complete master inventory.</li><li>Search the printed inventory ID or any spoken keyword.</li><li>Call out the destination code before the mover leaves the check-in point.</li><li>Tap Received only after the piece is physically accounted for.</li><li>Use Log issue for missing, damaged, mismatched, or unclear pieces.</li><li>Do not assume the 2024 total of 18 pallets maps to today's 14 crates.</li></ol>
    <h2>Before truck departure</h2>
    <ol><li>Filter to Remaining and inspect every result.</li><li>Review all Issues with the crew lead.</li><li>Confirm all 14 current crates are empty, using their physical labels.</li><li>Check the truck and staging areas before signing delivery completion.</li><li>Export a final backup and reconnect every phone.</li></ol>
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

function isVisible(item: InventoryItem, state: DerivedItemState): boolean {
  const searchMatches = !queryText || matchesSearch(createSearchText(item, state), queryText);
  if (!searchMatches) return false;
  if (filter === 'remaining') return !state.received;
  if (filter === 'received') return state.received;
  if (filter === 'issues') return state.issueCount > 0;
  if (filter === 'no-destination') return !state.destinationCode;
  if (filter === 'no-crate') return effectiveCrate(item, state) === 'UNASSIGNED';
  if (filter === 'high-value') return isHighValue(item);
  return true;
}

function effectiveCrate(item: InventoryItem, state: DerivedItemState): string {
  return state.assignedCrateId || item.crateId || 'UNASSIGNED';
}

function isHighValue(item: InventoryItem): boolean {
  return item.sourceFields['High Value'] === true;
}

function readinessCheck(label: string, ready: boolean, detail: string): string {
  return `<div class="readiness-check ${ready ? 'ready' : 'not-ready'}" data-ready="${ready}"><span class="check-icon">${ready ? '✓' : '!'}</span><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></div></div>`;
}

function metric(label: string, value: number, detail: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function modeButton(value: Mode, label: string): string {
  return `<button data-action="set-mode" data-mode="${value}" class="${mode === value ? 'active' : ''}">${label}</button>`;
}

function filterButton(value: StatusFilter, label: string): string {
  return `<button data-action="set-filter" data-filter="${value}" class="${filter === value ? 'active' : ''}">${label}</button>`;
}

function groupButton(value: GroupBy, label: string): string {
  return `<button data-action="set-group" data-group="${value}" class="${groupBy === value ? 'active' : ''}">${label}</button>`;
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

interface CountSummary {
  total: number;
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
  items: InventoryItem[];
}

function getAppRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('App root not found.');
  return root;
}
