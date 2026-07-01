import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config/move.config.ts'), 'utf8');

const searchHandler = main.slice(main.indexOf("if (input.id === 'search-input')"), main.indexOf("if (input.id === 'filter-range-from')"));
const checks = [
  ['search updates results without replacing the full app', searchHandler.includes('refreshSearchResults') && !searchHandler.includes('render();')],
  ['search result regions are targeted', main.includes('id="inventory-results"') && main.includes('id="exact-match-region"')],
  ['query keeps compact search active', main.includes("Boolean(queryText.trim()) || window.scrollY >= mobileLookupCollapseAt")],
  ['keyboard resize does not remeasure sticky threshold', main.includes("document.activeElement?.id === 'search-input'") && main.includes('scheduleMobileLookupSync()')],
  ['mobile mode tabs are not sticky', styles.includes('.mode-tabs { position: static; top: auto; z-index: auto; }')],
  ['mobile lookup sticks at safe-area top', styles.includes('.sticky-controls { top: max(4px, env(safe-area-inset-top)); }')],
  ['KPI progress animations do not replay on each render', !styles.includes('.move-progress-track span, .metric-progress span { animation:')],
  ['app version updated', config.includes("appVersion: '0.6.2'")]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${label}`);
if (failed.length) throw new Error(`v0.6.2 stability validation failed: ${failed.map(([label]) => label).join(', ')}`);
console.log('v0.6.2 mobile search stability validation passed.');
