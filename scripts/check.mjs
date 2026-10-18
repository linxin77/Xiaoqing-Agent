import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const excluded = new Set(['.git', 'node_modules', 'playwright-report', 'test-results', 'reports', 'data', 'secrets']);
async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (/\.m?js$/.test(entry.name)) {
            const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
            if (result.status !== 0) throw new Error(result.stderr);
        } else if (entry.name.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
        if (entry.isFile() && /\.(m?js|json|md|html|txt|ya?ml|css)$/.test(entry.name)) {
            const text = await readFile(file, 'utf8');
            if (/sk-or-v1-[a-f0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
                throw new Error(`疑似敏感凭据，停止发布检查：${path.relative(root, file)}`);
            }
        }
    }
}
await visit(root);
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
await readFile(path.join(root, manifest.js)); await readFile(path.join(root, manifest.css));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version || pkg.license !== 'MIT') throw new Error('版本或许可证声明不一致');
for (const file of ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md']) await readFile(path.join(root, file));
console.log('全部 JavaScript 语法、JSON、manifest、版本、发布文档和敏感凭据模式检查通过。');
