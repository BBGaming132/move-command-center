import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moveConfig = fs.readFileSync(path.join(root, 'src/config/move.config.ts'), 'utf8');
const authConfig = fs.readFileSync(path.join(root, 'src/config/auth.config.ts'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'scripts/bootstrap-firebase.mjs'), 'utf8');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');

const moveId = matchValue(moveConfig, /moveId:\s*'([^']+)'/, 'moveId');
const usernameDomain = matchValue(authConfig, /usernameDomain:\s*'([^']+)'/, 'usernameDomain');

for (const [label, text] of [['Firestore rules', rules], ['Firebase bootstrap', bootstrap]]) {
  if (!text.includes(moveId)) throw new Error(`${label} does not contain the configured moveId.`);
}
if (!bootstrap.includes(usernameDomain)) throw new Error('Firebase bootstrap username domain does not match the browser auth configuration.');
if (main.includes('inventory.generated.json')) throw new Error('The public app must not import the private inventory file.');

for (const requiredIgnore of [
  'private-data/*',
  '!private-data/README.md',
  '!private-data/users.template.json'
]) {
  if (!gitignore.includes(requiredIgnore)) throw new Error(`.gitignore is missing: ${requiredIgnore}`);
}

if (!rules.includes('allow write: if false;')) throw new Error('Firestore rules do not contain the expected deny-write protections.');
if (!rules.includes('request.resource.data.actorUid == request.auth.uid')) throw new Error('Firestore rules do not bind event actors to the authenticated UID.');
if (!rules.includes("'ITEM_ADD'") || !rules.includes("'ITEM_EDIT'") || !rules.includes("'ITEM_VOID'")) throw new Error('Firestore rules do not allow the protected emergency-item event types.');
if (!rules.includes("'SETTINGS_UPDATE'") || !rules.includes("'MOVE-SETTINGS'") || !rules.includes('hasCrateListing')) throw new Error('Firestore rules do not protect the shared crate-listing setting.');
if (!rules.includes("'DESTINATIONS_UPDATE'") || !rules.includes("'MOVE-DESTINATIONS'") || !rules.includes('catalogJson')) throw new Error('Firestore rules do not protect the shared destination catalog.');
if (!rules.includes('keepOriginalRoom')) throw new Error('Firestore rules do not allow the keep-original-room routing flag.');
if (!rules.includes("^EXTRA-[A-Z0-9]{8,24}$") || !rules.includes('38[9]') || !rules.includes('isSequentialExtraItemId')) throw new Error('Firestore rules do not restrict legacy and sequential emergency-item identifiers.');
if (!rules.includes('/shared/destinations') || !rules.includes('validSharedDestinationDocument') || !rules.includes('updatedByUid == request.auth.uid')) throw new Error('Firestore rules do not protect the authoritative shared destination document.');

console.log('Security configuration validation passed: move IDs, username domain, private-data exclusions, and actor rules are aligned.');

function matchValue(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`Unable to read ${label}.`);
  return match[1];
}
