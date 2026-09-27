/**
 * Writes assets/icon.svg: react-chessboard's own knight on a small board tile,
 * so the catalog picture matches the pieces in the game. Runs with the tests;
 * rewriting the same bytes is a no-op for git.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultPieces } from 'react-chessboard';
import { expect, it } from 'vitest';

it('renders the catalog icon', () => {
  const knight = renderToStaticMarkup(defaultPieces.wN({ fill: '#fafafa' }));
  const inner = knight.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const squares = [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) =>
    `<rect x="${8 + c * 28}" y="${8 + r * 28}" width="28" height="28" fill="${(r + c) % 2 ? '#3f3f46' : '#a1a1aa'}"/>`)).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Chess preview">`
    + `<rect width="128" height="128" rx="4" fill="#0a0a0a"/><g opacity="0.9">${squares}</g>`
    + `<svg x="14" y="10" width="100" height="100" viewBox="0 0 45 45">${inner}</svg></svg>`;
  writeFileSync(join(__dirname, '../assets/icon.svg'), svg);
  expect(svg).toContain('<path');
});
