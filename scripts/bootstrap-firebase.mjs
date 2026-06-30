import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moveId = 'n4CxhHlF8sszxyy9zdYt_I1B';
const usernameDomain = 'parents-move.invalid';
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : path.join(root, 'private-data', 'firebase-service-account.json');
const usersPath = path.join(root, 'private-data', 'users.local.json');
const inventoryPath = path.join(root, 'private-data', 'inventory.generated.json');

for (const requiredPath of [serviceAccountPath, usersPath, inventoryPath]) {
  if (!fs.existsSync(requiredPath)) {
    console.error(`Missing required private setup file: ${requiredPath}`);
    process.exit(1);
  }
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
const usersConfig = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const users = Array.isArray(usersConfig.users) ? usersConfig.users : [];
const browserConfigText = fs.readFileSync(path.join(root, 'src', 'config', 'firebase.config.ts'), 'utf8');
const browserProjectId = browserConfigText.match(/projectId:\s*'([^']+)'/)?.[1];
if (!browserProjectId || browserProjectId.startsWith('PASTE_')) {
  throw new Error('Paste the Firebase browser configuration into src/config/firebase.config.ts before running the bootstrap.');
}
if (browserProjectId !== serviceAccount.project_id) {
  throw new Error(`Firebase project mismatch: browser config uses ${browserProjectId}, but the service account belongs to ${serviceAccount.project_id}.`);
}

validateInventory(inventory);
validateUsers(users);

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id
  });
}

const auth = getAuth();
const db = getFirestore();
const activeUids = new Set();

console.log(`Bootstrapping secure move data in Firebase project ${serviceAccount.project_id}...`);

for (const entry of users) {
  const username = normalizeUsername(entry.username);
  const email = `${username}@${usernameDomain}`;
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    userRecord = await auth.updateUser(userRecord.uid, {
      password: entry.password,
      displayName: entry.displayName,
      emailVerified: true,
      disabled: false
    });
    console.log(`Updated authorized user @${username} (${userRecord.uid}).`);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
    userRecord = await auth.createUser({
      email,
      password: entry.password,
      displayName: entry.displayName,
      emailVerified: true,
      disabled: false
    });
    console.log(`Created authorized user @${username} (${userRecord.uid}).`);
  }

  activeUids.add(userRecord.uid);
  await db.doc(`moves/${moveId}/members/${userRecord.uid}`).set({
    username,
    displayName: entry.displayName,
    email,
    active: true,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

const existingMembers = await db.collection(`moves/${moveId}/members`).get();
for (const member of existingMembers.docs) {
  if (!activeUids.has(member.id)) {
    await member.ref.set({ active: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    try {
      await auth.updateUser(member.id, { disabled: true });
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    console.log(`Disabled Firebase access and move membership ${member.id} because it is not in users.local.json.`);
  }
}

const serializedBytes = Buffer.byteLength(JSON.stringify(inventory), 'utf8');
if (serializedBytes >= 900_000) {
  throw new Error(`Inventory document is ${serializedBytes} bytes; keep it below 900,000 bytes for Firestore safety margin.`);
}

await db.doc(`moves/${moveId}/private/inventory`).set(inventory);
console.log(`Uploaded ${inventory.items.length} private inventory records (${serializedBytes.toLocaleString()} bytes).`);
console.log('Bootstrap complete. Passwords were not printed or stored in Firestore.');

function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function validateUsers(entries) {
  if (entries.length < 1) throw new Error('users.local.json must contain at least one user.');
  const seen = new Set();
  const passwords = new Set();
  for (const [index, entry] of entries.entries()) {
    const username = normalizeUsername(entry.username);
    if (!username || username !== entry.username) throw new Error(`User ${index + 1}: username must already be lowercase and contain only letters, numbers, dots, underscores, or hyphens.`);
    if (seen.has(username)) throw new Error(`Duplicate username: ${username}`);
    seen.add(username);
    if (!String(entry.displayName ?? '').trim()) throw new Error(`@${username}: displayName is required.`);
    if (typeof entry.password !== 'string' || entry.password.length < 14) throw new Error(`@${username}: use a password of at least 14 characters.`);
    if (/replace|password|move123|changeme/i.test(entry.password)) throw new Error(`@${username}: replace the template password with a strong unique password.`);
    if (passwords.has(entry.password)) throw new Error(`@${username}: each account must use a different password.`);
    passwords.add(entry.password);
  }
}

function validateInventory(bundle) {
  if (bundle?.metadata?.status !== 'verified') throw new Error('Inventory status must be verified.');
  if (!Array.isArray(bundle.items) || bundle.items.length !== 388) throw new Error('Inventory must contain exactly 388 records.');
  const ids = bundle.items.map((item) => Number(item.itemId));
  if (!ids.every((id, index) => id === index + 1)) throw new Error('Inventory IDs must be continuous from 1 through 388.');
  const physicalCrates = (bundle.crates ?? []).filter((crate) => crate.isPhysical !== false);
  if (physicalCrates.length !== 14) throw new Error('Inventory must define exactly 14 physical current crates.');
}
