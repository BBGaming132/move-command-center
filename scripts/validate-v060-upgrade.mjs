import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const events = fs.readFileSync(path.join(root, 'src/lib/events.ts'), 'utf8');
const types = fs.readFileSync(path.join(root, 'src/types.ts'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const rooms = JSON.parse(fs.readFileSync(path.join(root, 'src/data/rooms.json'), 'utf8'));

const checks = [
  ['10-second receipt grace period', main.includes('const RECEIPT_GRACE_MS = 10_000')],
  ['stable one-time receipt animation tracking', main.includes('animatedReceiptIds') && styles.includes('receipt-countdown-stable')],
  ['shared destination event type', types.includes("'DESTINATIONS_UPDATE'") && events.includes('deriveDestinationCatalog')],
  ['destination catalog Firestore protection', rules.includes("'DESTINATIONS_UPDATE'") && rules.includes("'MOVE-DESTINATIONS'") && rules.includes('catalogJson')],
  ['keep-original-room routing', main.includes('bulk-keep-original') && main.includes('keepOriginalRoom') && rules.includes('keepOriginalRoom')],
  ['final room signs block incomplete routing', main.includes('Room signs are not ready yet') && !main.includes('for (const room of rooms.filter')],
  ['broken high-value source warning removed from readiness', !main.includes('One uploaded file could not be used')],
  ['progress KPI visuals', main.includes('renderMoveProgressHero') && styles.includes('.move-progress-hero') && styles.includes('.metric-progress')],
  ['master bedroom and kitchen defaults', rooms.some((room) => room.code === 'MASTER' && room.label === 'Master Bedroom') && rooms.some((room) => room.code === 'KITCHEN' && room.label === 'Kitchen')]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${label}`);
if (failed.length) throw new Error(`v0.6.0 upgrade validation failed: ${failed.map(([label]) => label).join(', ')}`);
console.log('v0.6.0 feature validation passed.');
