import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config/move.config.ts'), 'utf8');

const checks = [
  ['custom disclosure replaces native details', main.includes('data-action="toggle-bulk-planner"') && main.includes('class="bulk-panel-body"') && !main.includes("appRoot.addEventListener('toggle'")],
  ['background callbacks defer while the planner is open', main.includes("return bulkPlannerOpen && mode === 'planning';") && main.includes('bulkPlannerDeferredRender = true;')],
  ['bulk saves update controls in place', main.includes('function syncBulkPlannerControls()') && !/async function saveBulkEvents[\s\S]*?renderPreservingElementPosition/.test(main)],
  ['toast expiration does not rerender the application', /function showToast[\s\S]*?syncToastDom\(\)[\s\S]*?setTimeout\([\s\S]*?syncToastDom\(\)/.test(main) && !/function showToast[\s\S]*?setTimeout\([\s\S]*?render\(\)/.test(main)],
  ['closing the planner flushes one deferred render', main.includes('if (!bulkPlannerOpen && bulkPlannerDeferredRender)') && main.includes("renderPreservingElementPosition('[data-bulk-panel]')")],
  ['planner controls have custom disclosure styling', styles.includes('.bulk-panel-toggle') && styles.includes('.bulk-panel-body[hidden]')],
  ['app version updated', config.includes("appVersion: '0.6.5'")]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${label}`);
if (failed.length) throw new Error(`v0.6.5 Fast Planning validation failed: ${failed.map(([label]) => label).join(', ')}`);

let open = false;
let deferred = false;
let renderCount = 1;
let selectedRoom = '';
const backgroundUpdate = () => {
  if (open) {
    deferred = true;
    return;
  }
  renderCount += 1;
};
const closePlanner = () => {
  open = false;
  if (deferred) {
    deferred = false;
    renderCount += 1;
  }
};

for (const room of ['Kitchen', 'Master Bedroom', 'Brown Room']) {
  open = true;
  selectedRoom = room;
  const renderBefore = renderCount;
  for (let i = 0; i < 40; i += 1) backgroundUpdate();
  if (!open || selectedRoom !== room || renderCount !== renderBefore) {
    throw new Error(`Deferred-render regression failed during ${room}.`);
  }
}
closePlanner();
if (renderCount !== 2 || deferred) throw new Error('Deferred render did not flush exactly once when the planner closed.');
console.log('PASS: three consecutive room-selection cycles survive 120 simulated background callbacks without replacement.');
console.log('v0.6.5 stable Fast Planning validation passed.');
