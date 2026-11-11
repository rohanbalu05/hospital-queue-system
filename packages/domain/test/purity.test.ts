import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

describe('packages/domain is pure (D-004)', () => {
  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s: relative imports only, no clock, no randomness, no I/O', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    // Strip comments so the doc text may mention what is forbidden.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [...code.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
    for (const spec of specifiers) expect(spec, `${file} imports ${spec}`).toMatch(/^\.\//);
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(\s*\)/);
    expect(code).not.toMatch(/Math\.random\s*\(/);
    expect(code).not.toMatch(/\bprocess\./);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });
});
