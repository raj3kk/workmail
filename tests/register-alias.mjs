// Registers tests/alias-hooks.mjs for `node --import` runs.
import {register} from 'node:module';
register('./alias-hooks.mjs', import.meta.url);
