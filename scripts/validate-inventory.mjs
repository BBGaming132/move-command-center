import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(root, 'private-data', 'inventory.generated.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const errors = [];
const warnings = [];

if (!inventory.metadata) errors.push('Missing metadata object.');
if (!Array.isArray(inventory.crates)) errors.push('crates must be an array.');
if (!Array.isArray(inventory.items)) errors.push('items must be an array.');

const expectedCrates = Number(inventory.metadata?.expectedCrateCount ?? 14);
const physicalCrates = (inventory.crates ?? []).filter((crate) => crate.isPhysical !== false);
if (physicalCrates.length !== expectedCrates) {
  errors.push(`Expected ${expectedCrates} physical crates but found ${physicalCrates.length}.`);
}

const crateIds = new Set();
for (const crate of inventory.crates ?? []) {
  if (!crate.crateId) errors.push('A crate is missing crateId.');
  if (crateIds.has(crate.crateId)) errors.push(`Duplicate crateId: ${crate.crateId}`);
  crateIds.add(crate.crateId);
}
if (!crateIds.has('UNASSIGNED')) errors.push('The non-physical UNASSIGNED crate bucket is required.');

const itemIds = new Set();
const numericIds = [];
for (const [index, item] of (inventory.items ?? []).entries()) {
  const prefix = `Item index ${index}`;
  if (!item.itemId) errors.push(`${prefix}: missing itemId.`);
  if (itemIds.has(item.itemId)) errors.push(`${prefix}: duplicate itemId ${item.itemId}.`);
  itemIds.add(item.itemId);
  const numericId = Number(item.itemId);
  if (!Number.isInteger(numericId)) errors.push(`${item.itemId}: itemId must be the printed numeric inventory ID.`);
  numericIds.push(numericId);
  if (!crateIds.has(item.crateId)) errors.push(`${item.itemId}: unknown crateId ${item.crateId}.`);
  if (!Number.isInteger(item.sequence) || item.sequence < 1) errors.push(`${item.itemId}: sequence must be a positive integer.`);
  if (item.sequence !== numericId) errors.push(`${item.itemId}: sequence must match the printed inventory ID.`);
  if (!String(item.description ?? '').trim()) errors.push(`${item.itemId}: missing description.`);
  if (!String(item.rawLine ?? '').trim()) errors.push(`${item.itemId}: missing rawLine source preservation.`);
  if (!item.sourceFields || typeof item.sourceFields !== 'object') errors.push(`${item.itemId}: missing sourceFields.`);
  if (!Array.isArray(item.tags) || item.tags.length < 3) errors.push(`${item.itemId}: tags must contain searchable source data.`);
  if (inventory.metadata?.status === 'verified') {
    if (!Number.isInteger(item.sourcePage) || item.sourcePage < 4 || item.sourcePage > 20) errors.push(`${item.itemId}: sourcePage must point to inventory pages 4-20.`);
    if (!String(item.sourceRow ?? '').includes(`ID ${item.itemId}`)) errors.push(`${item.itemId}: sourceRow must preserve the printed ID.`);
    if (Number(item.sourceFields?.['Inventory ID']) !== numericId) errors.push(`${item.itemId}: sourceFields Inventory ID mismatch.`);
    if (!String(item.sourceFields?.Content ?? '').trim()) errors.push(`${item.itemId}: missing Content source field.`);
    if (!String(item.sourceFields?.['Pack Type'] ?? '').trim()) errors.push(`${item.itemId}: missing Pack Type source field.`);
    if (!String(item.sourceFields?.['Original Room'] ?? '').trim()) errors.push(`${item.itemId}: missing Original Room source field.`);
  }
}

const expectedItems = Number(inventory.metadata?.expectedItemCount ?? 388);
if ((inventory.items ?? []).length !== expectedItems) errors.push(`Expected ${expectedItems} items but found ${inventory.items?.length ?? 0}.`);
const sortedIds = [...numericIds].sort((a, b) => a - b);
for (let id = 1; id <= expectedItems; id += 1) {
  if (sortedIds[id - 1] !== id) {
    errors.push(`Inventory ID continuity failed at ${id}.`);
    break;
  }
}

if (inventory.metadata?.status === 'verified') {
  if ((inventory.items ?? []).length === 0) errors.push('Verified inventory cannot contain zero items.');
  if (!Array.isArray(inventory.metadata.sourceDocuments) || inventory.metadata.sourceDocuments.length === 0) {
    errors.push('Verified inventory requires sourceDocuments metadata.');
  }
  if (inventory.metadata.crateMappingStatus === 'not-provided-in-source') {
    warnings.push('Source documents contain no item-to-current-crate map. Items correctly begin in UNASSIGNED.');
  }
} else {
  warnings.push('Inventory status is placeholder; live receiving remains locked.');
}

if (errors.length) {
  console.error('\nInventory validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Inventory validation passed: ${physicalCrates.length} physical crates, ${inventory.items.length} pieces, ${itemIds.size} unique printed IDs.`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);
