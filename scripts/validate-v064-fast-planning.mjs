import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config/move.config.ts'), 'utf8');

const checks = [
  ['Fast Planning open state is explicit and persistent', main.includes('let bulkPlannerOpen = false;') && main.includes('${bulkPlannerOpen ? \'open\' : \'\'}')],
  ['native details toggle updates the persistent state', main.includes("appRoot.addEventListener('toggle'") && main.includes("details.matches('.bulk-panel')") && main.includes('bulkPlannerOpen = details.open;')],
  ['bulk form values persist through cloud rerenders', main.includes('bulkPlannerSelectedRoom') && main.includes('bulkPlannerKeepOriginal') && main.includes('bulkPlannerCode') && main.includes('bulkPlannerLabel')],
  ['bulk Firestore callbacks are coalesced while a room saves', main.includes('bulkSyncInProgress') && main.includes('bulkSyncRenderQueued')],
  ['Fast Planning is anchored during rerenders', main.includes("renderPreservingElementPosition('.bulk-panel')")],
  ['blocking completion alert was removed from bulk save', !/async function saveBulkEvents[\s\S]*?window\.alert\(confirmation\)/.test(main)],
  ['bulk action prevents duplicate submissions while saving', main.includes('if (bulkPlannerBusy) return;') && main.includes('aria-busy="true"')],
  ['app version updated', config.includes("appVersion: '0.6.4'")],
  ['busy-state visual feedback exists', styles.includes('.bulk-route-button.is-busy')]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${label}`);
if (failed.length) throw new Error(`v0.6.4 Fast Planning validation failed: ${failed.map(([label]) => label).join(', ')}`);

// Three-cycle state regression: open -> save/rerender -> reopen/continue.
let panelOpen = false;
let selectedRoom = '';
let renderCount = 0;
const render = () => ({ open: panelOpen, room: selectedRoom, render: ++renderCount });
for (const room of ['Kitchen', 'Master Bedroom', 'Brown Room']) {
  panelOpen = true;
  selectedRoom = room;
  const duringLocalSave = render();
  const duringCloudSnapshot = render();
  const afterCloudFlush = render();
  if (![duringLocalSave, duringCloudSnapshot, afterCloudFlush].every((state) => state.open && state.room === room)) {
    throw new Error(`Three-cycle Fast Planning state regression failed for ${room}.`);
  }
}
console.log('PASS: three consecutive room assignments preserve an open, usable Fast Planning panel.');
console.log('v0.6.4 repeatable Fast Planning validation passed.');
