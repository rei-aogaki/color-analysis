import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const allowedEmail = value => /^(?:\d+\+)?[\w-]+@users\.noreply\.github\.com$/i.test(value) || value === 'noreply@github.com';
const allowedName = value => ['rei-aogaki', 'GitHub'].includes(value) || /^[\w-]+\[bot\]$/.test(value);

// Findings deliberately contain rule names only, never matched private values.
export function inspectText(content) {
  const findings = [];
  if (/[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]Claude[_-]|\/(?:Users|home)\/[\w.-]+\//.test(content)) findings.push('personal-local-path');
  const emails = content.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
  if (emails.some(value => !allowedEmail(value) && !value.endsWith('.invalid'))) findings.push('non-noreply-email');
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content)) findings.push('credential-pattern');
  return findings;
}

export function inspectIdentity(name, email) {
  return [...(!allowedName(name) ? ['unapproved-public-name'] : []), ...(!allowedEmail(email) ? ['non-noreply-email'] : [])];
}

function inspectPath(path) {
  return /(?:^|\/)(?:\.env(?:\..*)?|node_modules|\.local|dist|test-results|playwright-report|coverage)(?:\/|$)|\.(?:log|png|jpe?g|webp|gif|zip|pem|key|pfx|pdf|docx)$/i.test(path) ? ['private-or-generated-file'] : [];
}

async function audit(kind) {
  const findings = []; let files = 0, commits = 0;
  const add = (location, rules) => { for (const rule of rules) findings.push({ location, rule }); };
  if (kind === 'source') {
    const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    for (const path of new Set(paths)) {
      const absolute = resolve(root, path);
      const stat = await lstat(absolute).catch(() => undefined); if (!stat) continue;
      files++; add(path, inspectPath(path));
      if (!stat.isFile() || stat.isSymbolicLink()) { add(path, ['non-regular-file']); continue; }
      add(path, inspectText(await readFile(absolute, 'utf8')));
    }
  } else if (kind === 'history') {
    if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') throw Error('Full history is required.');
    const seen = new Set();
    // Inspect publishable refs, not local editor checkpoints or reflogs.
    const refs = git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']).trim().split('\n').filter(Boolean);
    if (!refs.length) throw Error('No publishable history found.');
    for (const sha of git(['rev-list', ...refs]).trim().split('\n').filter(Boolean)) {
      commits++;
      const [an, ae, cn, ce, ...message] = git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', sha]).trimEnd().split('\n').map(s => s.replace(/\r$/, ''));
      const label = `commit ${sha.slice(0, 7)}`;
      add(label + ' author', inspectIdentity(an, ae)); add(label + ' committer', inspectIdentity(cn, ce)); add(label + ' message', inspectText(message.join('\n')));
      for (const entry of git(['ls-tree', '-rz', sha]).split('\0').filter(Boolean)) {
        const [meta, path] = entry.split('\t'); const [mode, type, oid] = meta.split(' ');
        add(label + ':' + path, inspectPath(path));
        if (type !== 'blob' || mode === '120000') { add(label + ':' + path, ['non-regular-file']); continue; }
        if (seen.has(oid)) continue; seen.add(oid); files++;
        add(label + ':' + path, inspectText(git(['cat-file', 'blob', oid])));
      }
    }
  } else if (kind === 'dist') {
    const dir = resolve(root, 'dist');
    const actual = [];
    async function walk(path = '') {
      for (const entry of await readdir(resolve(dir, path), { withFileTypes: true })) {
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory() && name === 'assets') await walk(name);
        else if (entry.isFile()) actual.push(name);
        else add(name, ['unexpected-artifact-entry']);
      }
    }
    await walk();
    const manifest = JSON.parse(await readFile(resolve(dir, 'asset-manifest.json'), 'utf8'));
    if (!Array.isArray(manifest) || JSON.stringify([...new Set(manifest)].sort()) !== JSON.stringify(actual.toSorted())) add('dist', ['manifest-mismatch']);
    const required = ['index.html', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'asset-manifest.json'];
    for (const name of required) if (!actual.includes(name)) add(name, ['missing-artifact']);
    for (const path of actual) {
      files++;
      if (!required.includes(path) && !/^assets\/[\w.-]+\.(?:js|css)$/.test(path)) add(path, ['unexpected-artifact-file']);
      const content = await readFile(resolve(dir, path), 'utf8'); add(path, inspectText(content));
      if (path.endsWith('.html') && (!content.includes('Content-Security-Policy') || !content.includes("connect-src 'none'") || !content.includes('no-referrer'))) add(path, ['missing-browser-policy']);
      if (/sourceMappingURL=/.test(content)) add(path, ['source-map-reference']);
    }
    if (actual.some(path => /design/i.test(path))) add('dist', ['comparison-page-in-production']);
  } else throw Error('Use source, history or dist.');
  console.log(JSON.stringify({ kind, files, commits, findings }, null, 2));
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  audit(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
