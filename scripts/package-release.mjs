import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(release, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(release, 'site'), { recursive: true });
for (const file of ['README.md', 'SETUP_GUIDE.md', 'DAY_OF_CHECKLIST.md', 'DECOMMISSION.md', 'RELEASE_NOTES.md', 'PROJECT_SPEC.md']) {
  fs.copyFileSync(path.join(root, file), path.join(release, file));
}
console.log(`Public release folder created at ${release}. Private inventory and credentials were intentionally excluded.`);
