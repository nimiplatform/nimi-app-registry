import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { loadValidators } from './registry-validation.mjs';
import { projectSources, readProducts } from './hosted-products.mjs';

const args = process.argv.slice(2);
if (args.some((x) => !['--write', '--local'].includes(x)))
  throw new Error('Use --write to regenerate, --local only for a development checkout.');
const root = path.resolve(process.cwd());
const { products, projections } = await readProducts(root, await loadValidators(), {
  localDevelopment: args.includes('--local'),
});
await projectSources(root, projections, args.includes('--write'));
const indexPath = path.join(root, 'index.json');
const index = JSON.parse(await readFile(indexPath, 'utf8'));
let changed = false;
for (const [id, row] of Object.entries(index.apps)) {
  const product = products.get(id)?.product;
  if (!product) throw new Error('Missing native product: ' + id);
  if (!isDeepStrictEqual(row.kill_switch, product.kill_switch)) {
    if (!args.includes('--write')) throw new Error('Native index policy differs: ' + id);
    row.kill_switch = product.kill_switch;
    changed = true;
  }
}
if (changed) await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log('Verified ' + projections.size + ' source projections.');
