import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
if (!fs.existsSync(dist)) throw new Error('dist folder does not exist. Run the production build first.');

const publicFiles = walk(dist).filter((file) => /\.(js|css|html|json|webmanifest|txt|map)$/i.test(file));
const publicText = publicFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const sourceText = walk(path.join(root, 'src')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');

if (sourceText.includes("inventory.generated.json")) {
  throw new Error('Public source still references inventory.generated.json. The private inventory must only be loaded from authenticated Firestore.');
}

const inventoryPath = path.join(root, 'private-data', 'inventory.generated.json');
if (fs.existsSync(inventoryPath)) {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const forbidden = [];
  for (const document of inventory.metadata?.sourceDocuments ?? []) {
    if (document.fileName) forbidden.push(String(document.fileName));
  }
  for (const item of inventory.items ?? []) {
    const raw = String(item.rawLine ?? '').trim();
    if (raw.length >= 28) forbidden.push(raw);
  }
  const leaks = [...new Set(forbidden)].filter((value) => value && publicText.includes(value));
  if (leaks.length) {
    console.error('Public build privacy check failed. Private inventory text was found in dist:');
    for (const leak of leaks.slice(0, 20)) console.error(`- ${leak.slice(0, 160)}`);
    process.exit(1);
  }
}

console.log('Public build privacy check passed: the private inventory is not bundled into dist.');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
