import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
await copyFile(new URL('LICENSE', root), new URL('dist/LICENSE.txt', root));
const viteLicense = await readFile(new URL('node_modules/vite/LICENSE.md', root), 'utf8');
const coreLicense = viteLicense.slice(viteLicense.indexOf('MIT License'), viteLicense.indexOf('SOFTWARE.') + 'SOFTWARE.'.length);
await writeFile(new URL('dist/THIRD_PARTY_NOTICES.txt', root), 'Vite module preload helper\n\n' + coreLicense + '\n');
const assets = await readdir(new URL('dist/assets/', root));
const entries = process.argv.includes('--pages') ? ['index.html'] : ['index.html', 'design.html'];
await writeFile(new URL('dist/asset-manifest.json', root), JSON.stringify([...entries,'LICENSE.txt','THIRD_PARTY_NOTICES.txt','asset-manifest.json',...assets.map(name => `assets/${name}`)], null, 2));
