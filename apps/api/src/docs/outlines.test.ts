import { describe, it, expect } from 'vitest';
import { TemplateGenerator, LlmGenerator, type DocContext } from './generator.js';
import { outline, outlineInstruction, type StackKey } from './outlines.js';

const ctx = (stackKey: StackKey, extra: Partial<DocContext> = {}): DocContext => ({ title: 'T', summary: 'S', transcript: [], stackKey, ...extra });
const gen = new TemplateGenerator();

describe('technology outlines', () => {
  it.each([
    ['sap', 'Authorizations', 'Transports & Deployment'], ['dotnet', 'Solution Structure', 'Packages & Dependencies'],
    ['java', 'Module & Package Structure', 'Dependencies'], ['node', 'Application Structure', 'Packages & Dependencies'], ['generic', 'Technical Design', 'Security & Configuration'],
  ] as const)('%s Technical Specification follows its own sections', async (stack, a, b) => {
    const md = await gen.generate('TS', ctx(stack));
    expect(md).toContain(a); expect(md).toContain(b);
    expect(outline(stack, 'TS')[0].title).toBe('Technical Objects');
  });

  it('keeps one stack’s vocabulary out of another’s outline', async () => {
    expect(await gen.generate('TS', ctx('java'))).not.toMatch(/Authorizations|Transports|NuGet/);
    expect(await gen.generate('TS', ctx('dotnet'))).not.toMatch(/Maven|Transports/);
  });

  it('adds technology-specific checks to the code review', async () => {
    const ts = '## Technical Objects\n- Report ZVENDOR\n';
    expect(await gen.generate('CRC', ctx('sap', { ts }))).toContain('AUTHORITY-CHECK');
    expect(await gen.generate('CRC', ctx('node', { ts }))).toContain('npm audit');
    expect(await gen.generate('CRC', ctx('node', { ts }))).not.toContain('AUTHORITY-CHECK');
  });

  it('gives the AI the same outline it would get offline', async () => {
    let sys = '';
    await new LlmGenerator({ complete: async (s: string) => { sys = s; return '# x'; } } as never).generate('TS', ctx('sap'));
    expect(sys).toContain(outlineInstruction('sap', 'TS')); expect(sys).toContain('Authorizations');
  });
});
