import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as sass from 'sass';

/**
 * Node module hooks that understand the two import suffixes the components are built on.
 *
 * A component is three files, and `.ts` is the only one of them Node can load by itself:
 * `import html from './hud.html?raw'` and `import css from './hud.scss?inline'` are Vite's,
 * and without them the tests would have to run against a bundle — asserting on minified,
 * hash-named output instead of on the sources anyone actually edits.
 *
 * So the suffixes are taught to Node rather than the tests being moved off the sources.
 * `?raw` is the file, `?inline` is the file compiled if it is Sass, and both arrive as a
 * module with the string as its default export — which is exactly what Vite produces.
 */

/** Anything a component pulls in as text rather than as code. */
const TEXT_IMPORT = /\.(?:html|svg|css|scss)(?:\?[a-z]+)?$/;

/** Strips the `?raw`/`?inline` query, which is addressing rather than part of the path. */
function pathOf(url) {
  const clean = new URL(url);
  clean.search = '';
  return fileURLToPath(clean);
}

export async function resolve(specifier, context, nextResolve) {
  if (TEXT_IMPORT.test(specifier)) {
    // Resolved by hand because Node's resolver would take `.html?raw` for an unknown
    // extension and refuse it before `load` ever got a chance to answer.
    return {
      url: new URL(specifier, context.parentURL).href,
      format: 'module',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !TEXT_IMPORT.test(url)) return nextLoad(url, context);

  const file = pathOf(url);
  // Compiled rather than read, because a component's sheet is Sass and the assertions in
  // the tests are about the CSS it becomes — nesting and all.
  const text = file.endsWith('.scss')
    ? sass.compile(file, { style: 'expanded' }).css
    : await readFile(file, 'utf8');

  return {
    format: 'module',
    // JSON.stringify is the escaping: templates carry quotes, newlines and backslashes in
    // SVG path data, and any of the three would otherwise end the string early.
    source: `export default ${JSON.stringify(text)};`,
    shortCircuit: true,
  };
}
