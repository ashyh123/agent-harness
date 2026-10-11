/** Offline common scoring, retaining the untouched original comparison.json. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {checkSubmittedOutput} from './reading_validation.js';
const directory=resolve(process.argv[2]??'');
if(!process.argv[2]) throw new Error('Provide experiment directory');
const d=JSON.parse(await readFile(join(directory,'comparison.json'),'utf8'));
for(const r of d.rows) {
  const record=JSON.parse(await readFile(join(r.directory,'run.json'),'utf8'));
  const submitted=checkSubmittedOutput(r.result?.answer??null,record.input.readingContract,r.result?.events??[]);
  Object.assign(r,submitted,{strict_accepted:r.checks.passed && submitted.valid_json_output
    && submitted.common_structural_check?.passed!==false});
}
await writeFile(join(directory,'review.json'),JSON.stringify(d,null,2));
console.log(`Scored ${d.rows.length} existing runs; no API requests.`);
