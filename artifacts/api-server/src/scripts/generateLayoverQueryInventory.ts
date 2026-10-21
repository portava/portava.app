import { writeFileSync } from 'node:fs';
import { generateLayoverQueryInventory } from '../test/helpers/layoverQueryInventory.js';
const inventory=generateLayoverQueryInventory();
writeFileSync(new URL('../../../../docs/ops/layover-query-inventory.json',import.meta.url),JSON.stringify(inventory,null,2)+'\n');
console.log(`${inventory.refs.length} schema references; ${inventory.selects.length} selects; ${inventory.literals.length} literal sites; ${inventory.unresolved.length} unresolved.`);
