import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractArtifacts } from './artifacts.ts';

const long = Array.from({ length: 31 }, (_, i) => `x = ${i}`).join('\n');

describe('extractArtifacts', () => {
  it('picks tagged blocks and long code, skips short code', () => {
    const text = [
      'Intro',
      '```html\n<html><h1>My <b>page</b></h1></html>\n```',
      '```python\nprint(1)\n```',
      '```tsx\nexport default () => <div/>;\n```',
      '~~~mermaid\ngraph TD; A-->B\n~~~',
      `\`\`\`python\n${long}\n\`\`\``,
    ].join('\n\n');
    const a = extractArtifacts('m1', text);
    expect(a.map((x) => [x.kind, x.title, x.language])).toEqual([
      ['html', 'My page', 'html'],
      ['react', 'tsx #2', 'tsx'],
      ['mermaid', 'mermaid #3', 'mermaid'],
      ['code', 'python #4', 'python'],
    ]);
    expect(a[0]?.id).toBe(createHash('sha1').update('m10').digest('hex'));
    expect(a[2]?.content).toBe('graph TD; A-->B');
    expect(a[3]?.content).toBe(long);
  });

  it('ignores unclosed fences and plain text', () => {
    expect(extractArtifacts('m', 'no code')).toEqual([]);
    expect(extractArtifacts('m', '```html\n<p>open')).toEqual([]);
  });

  it('uses a markdown heading for long markdown', () => {
    const md = `# Plan\n${long}`;
    expect(extractArtifacts('m', `\`\`\`md\n${md}\n\`\`\``)[0]?.title).toBe('Plan');
  });
});
