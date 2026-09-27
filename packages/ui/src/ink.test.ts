import { describe, expect, it } from 'vitest';

import { inkFor } from './mount.js';

describe('inkFor', () => {
  it('puts dark text on the lime accent and light text on the purple relay accent', () => {
    expect(inkFor('#b4f953')).toBe('#0a0a0a');
    expect(inkFor('#a855f7')).toBe('#fafafa');
    expect(inkFor('#7c3aed')).toBe('#fafafa');
  });
});
