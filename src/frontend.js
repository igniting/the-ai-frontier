// Front end: parse the prelude and the user program, then type-check them
// together. The prelude is re-parsed for every compilation because type
// checking annotates AST nodes in place.

import { parse } from './parser.js';
import { typecheck } from './typecheck.js';
import { PRELUDE } from './prelude.js';

export function frontend(source) {
  const preludeAst = parse(PRELUDE);
  const userAst = parse(source);
  const checked = typecheck(preludeAst, userAst);
  return { ...checked, preludeAst, userAst };
}
