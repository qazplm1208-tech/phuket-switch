// Refresh the route tables without duplicating DTO names, paths, or methods.
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const types = new URL('../shared/types.ts', import.meta.url);
const doc = new URL('../shared/api-contract.md', import.meta.url);
const source = ts.createSourceFile('types.ts', readFileSync(types, 'utf8'), ts.ScriptTarget.Latest, true);
const table = (name) => {
  const contract = source.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === name);
  const route = source.statements.find(n => ts.isTypeAliasDeclaration(n) && n.name.text === 'Route');
  return [
    '| Method and path | Input | Status | Response |',
    '| --- | --- | --- | --- |',
    ...contract.members.map(member => {
      const [input, response, status = route.typeParameters[2].default] = member.type.typeArguments;
      return `| \`${member.name.text}\` | \`${input.getText()}\` | ${status.getText()} | \`${response.getText()}\` |`;
    }),
  ].join('\n');
};

const current = readFileSync(doc, 'utf8').replaceAll('\r\n', '\n');
const marker = '<!-- Generated route tables -->';
if (!current.includes(marker)) throw new Error('Missing route table marker');
const result = [current.split(marker)[0] + marker, '## Management', table('ApiContract'),
  '## Inference', table('InferenceContract')].join('\n\n') + '\n';
if (process.argv.includes('--check')) {
  if (current !== result) throw new Error('Route tables are stale: run node scripts/api-contract.mjs');
} else {
  writeFileSync(doc, result);
}
