import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config/move.config.ts'), 'utf8');

const checks = [
  ['mobile toolbar exists', main.includes('mobile-lookup-toolbar') && main.includes('toggle-mobile-lookup')],
  ['scroll-driven condensation is installed', main.includes('scheduleMobileLookupSync') && main.includes('mobileLookupCollapseAt')],
  ['desktop remains outside mobile breakpoint', styles.includes('@media (max-width: 700px)') && styles.includes('html.mobile-lookup-condensed')],
  ['condensed state hides lookup options', styles.includes('html.mobile-lookup-condensed .lookup-options') && styles.includes('display: none')],
  ['expanded state restores options', styles.includes('mobile-lookup-expanded .lookup-options') && styles.includes('max-height: min(58dvh, 510px)')],
  ['search remains outside collapsible options', main.indexOf('class=\"search-box enhanced-search\"') < main.indexOf('class=\"lookup-options\"')],
  ['app version updated', config.includes("appVersion: '0.6.1'")]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${label}`);
if (failed.length) throw new Error(`v0.6.1 mobile upgrade validation failed: ${failed.map(([label]) => label).join(', ')}`);
console.log('v0.6.1 mobile lookup validation passed.');
