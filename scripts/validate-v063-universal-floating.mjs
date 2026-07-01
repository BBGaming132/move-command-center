import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config/move.config.ts'), 'utf8');

const checks = [
  ['full lookup remains in normal document flow', styles.includes('.sticky-controls { position: relative; top: auto; z-index: auto; }')],
  ['mode navigation is not sticky on any screen size', styles.includes('.mode-tabs { display: grid;') && styles.includes('position: static;')],
  ['floating lookup is driven by an end-of-block sentinel', main.includes('class="lookup-sentinel"') && main.includes('new IntersectionObserver')],
  ['floating lookup clones the stable full controls instead of transforming them in place', main.includes('cloneNode(true)') && main.includes("clone.classList.add('floating-lookup')")],
  ['floating lookup is available at every viewport width', styles.includes('.floating-lookup {') && !styles.includes('html.mobile-lookup-condensed')],
  ['old scroll-threshold implementation is removed', !main.includes('mobileLookupCollapseAt') && !main.includes('scheduleMobileLookupSync') && !main.includes('pinMobileSearchToTop')],
  ['search inputs synchronize without a whole-app render per keystroke', main.includes("document.querySelectorAll<HTMLInputElement>('[data-search-input]')") && main.includes('refreshSearchResults')],
  ['floating filters retain unique ids and route events to source controls', main.includes('element.dataset.sourceId = sourceId') && main.includes('const sourceId = input.dataset.sourceId ?? input.id')],
  ['floating options can scroll without locking the page', styles.includes('overscroll-behavior: contain') && styles.includes('overflow-y: auto')],
  ['app version updated', config.includes("appVersion: '0.6.3'")]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${label}`);
if (failed.length) throw new Error(`v0.6.3 universal floating lookup validation failed: ${failed.map(([label]) => label).join(', ')}`);
console.log('v0.6.3 universal floating lookup validation passed.');
