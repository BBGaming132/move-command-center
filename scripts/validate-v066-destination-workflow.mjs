import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'src/lib/firebase-sync.ts'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config/move.config.ts'), 'utf8');
const helperSource = fs.readFileSync(path.join(root, 'src/lib/destination-controls.ts'), 'utf8');
const searchSource = fs.readFileSync(path.join(root, 'src/lib/search.ts'), 'utf8');

// Test 1: destination selectors and sequential extras behave deterministically.
const helperJs = ts.transpileModule(helperSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
  }
}).outputText;
const helperPath = path.join(os.tmpdir(), `mcc-destination-controls-${process.pid}-${Date.now()}.mjs`);
fs.writeFileSync(helperPath, helperJs);
const helper = await import(`${pathToFileURL(helperPath).href}?v=${Date.now()}`);
fs.unlinkSync(helperPath);

const catalog = [
  { code: 'A', label: 'Room A', active: true },
  { code: 'SUNROOM', label: 'Sunroom', active: true },
  { code: 'HIDDEN', label: 'Hidden Room', active: false }
];
assert.equal(helper.normalizeDestinationCode(' sunroom '), 'SUNROOM');
assert.equal(helper.destinationLabelForCode(catalog, 'sunroom'), 'Sunroom');
assert.equal(helper.destinationLabelForCode(catalog, ''), '');
assert.deepEqual(helper.destinationOptions(catalog).map((room) => room.code), ['A', 'SUNROOM']);
assert.equal(helper.nextSequentialExtraItemId([{ itemId: '388' }, { itemId: '389' }]), '390');
assert.equal(helper.nextSequentialExtraItemId([{ itemId: '388' }, { itemId: 'EXTRA-ABC12345' }]), '389');
assert.equal(helper.isValidSequentialExtraItemId('389'), true);
assert.equal(helper.isValidSequentialExtraItemId('388'), false);
assert.equal(helper.isValidSequentialExtraItemId('1000'), true);
const searchJs = ts.transpileModule(searchSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove }
}).outputText;
const searchPath = path.join(os.tmpdir(), `mcc-search-${process.pid}-${Date.now()}.mjs`);
fs.writeFileSync(searchPath, searchJs);
const search = await import(`${pathToFileURL(searchPath).href}?v=${Date.now()}`);
fs.unlinkSync(searchPath);
const extra389 = {
  itemId: '389', crateId: 'UNASSIGNED', sequence: 10000, description: 'Unlabeled box', originalRoom: 'Sunroom', originalCode: 'Loose item', rawLine: 'Move-day extra', sourceFields: { Content: 'Unlabeled box', Comments: '', 'Pack Type': 'Loose item', 'Original Room': 'Sunroom' }, tags: ['extra'], isAdHoc: true
};
const blankState = { received: false, issueCount: 0 };
assert.equal(search.evaluateSearch(extra389, blankState, '389').matched, true);
assert.equal(search.evaluateSearch(extra389, blankState, '390').matched, false);
console.log('PASS 1: code selection, automatic labels, clear-state behavior, sequential item numbers, and exact extra-item search are deterministic.');

// Test 2: source integration covers phone/desktop controls and collapsed destination groups.
const integrationChecks = [
  ['app version is v0.6.6', config.includes("appVersion: '0.6.6'")],
  ['routing uses native selects for reliable iPhone code selection', main.includes('data-destination-code') && main.includes('<select id="${escapeHtml(codeId)}"')],
  ['destination labels are readonly', main.includes('readonly aria-readonly="true" tabindex="-1"')],
  ['clear X resets code and label', main.includes("action === 'clear-destination-code'") && main.includes("labelInput.value = ''")],
  ['destination groups default collapsed and track expansion', main.includes("const open = Boolean(queryText) || expandedGroupKeys.has(group.key)") && main.includes('data-group-key')],
  ['collapse-all and expand-all controls exist', main.includes("action === 'collapse-all-groups'") && main.includes("action === 'expand-all-groups'")],
  ['new extras default to Sunroom and a sequential item number', main.includes("editingItem ? '' : 'Sunroom'") && main.includes('nextSequentialExtraItemId(items)')],
  ['responsive styles exist for selectors and group toolbar', styles.includes('.destination-code-control') && styles.includes('@media (max-width: 620px)') && styles.includes('.group-toolbar')]
];
for (const [label, passed] of integrationChecks) {
  if (!passed) throw new Error(`Integration check failed: ${label}`);
}
console.log('PASS 2: mobile and desktop markup includes native selectors, readonly labels, clear controls, and collapsed room groups.');

// Test 3: authoritative cross-device destination sync and Firestore protection are wired end to end.
const syncChecks = [
  ['shared destination listener exists', sync.includes("'shared', 'destinations'") && sync.includes('unsubscribeDestinations')],
  ['shared destination save exists', sync.includes('async saveDestinationCatalog(catalog') && sync.includes('updatedByUid')],
  ['app prefers synchronized catalog', main.includes('sharedDestinationCatalog?.length')],
  ['legacy event catalog migrates automatically', main.includes('ensureSharedDestinationCatalogMigrated')],
  ['rules protect shared document', rules.includes('/shared/destinations') && rules.includes('validSharedDestinationDocument')],
  ['rules allow sequential extras from 389 onward', rules.includes('isSequentialExtraItemId') && rules.includes('38[9]')]
];
for (const [label, passed] of syncChecks) {
  if (!passed) throw new Error(`Sync/security check failed: ${label}`);
}
console.log('PASS 3: destination catalogs synchronize through a protected shared document, with legacy-event migration and sequential-extra rules.');

console.log('v0.6.6 destination workflow validation passed.');
