/**
 * Two shareable pages that carry the screenshots inline.
 *
 * They are kept here as templates with __TOKEN__ placeholders rather than as
 * finished files, because embedding six PNGs as base64 would put two megabytes
 * of duplicated bytes in the repository. Run this to produce the real pages:
 *
 *   node switchboard/collateral/build.mjs        → writes ./dist/*.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, '..', 'screenshots');
const out = join(here, 'dist');

const uri = (name) =>
  'data:image/png;base64,' + readFileSync(join(shots, name)).toString('base64');

const pages = {
  'device-preview.html': {
    __MAC__: 'mac-properties.png',
    __WIN__: 'windows-properties.png',
    __MOB__: 'mobile-properties.png',
    __TODAY__: 'mac-today.png',
    __DARK__: 'mac-reply-queue-dark.png',
    __FOLLOW__: 'mobile-followups.png',
  },
  'build-brief.html': { __SHOT__: 'mac-properties.png' },
};

mkdirSync(out, { recursive: true });
for (const [page, tokens] of Object.entries(pages)) {
  let html = readFileSync(join(here, page), 'utf8');
  for (const [token, file] of Object.entries(tokens)) html = html.replaceAll(token, uri(file));
  writeFileSync(join(out, page), html);
  console.log(`${page.padEnd(22)} ${(html.length / 1048576).toFixed(2)} MB`);
}
