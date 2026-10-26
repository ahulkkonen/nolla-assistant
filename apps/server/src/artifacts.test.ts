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
      '```vega-lite\n{"title": {"text": ["Myynti", "2026"]}, "mark": "bar"}\n```',
      `\`\`\`python\n${long}\n\`\`\``,
    ].join('\n\n');
    const a = extractArtifacts('m1', text);
    expect(a.map((x) => [x.kind, x.title, x.language])).toEqual([
      ['html', 'My page', 'html'],
      ['react', 'tsx #2', 'tsx'],
      ['mermaid', 'mermaid #3', 'mermaid'],
      ['vega-lite', 'Myynti 2026', 'vega-lite'],
      ['code', 'python #5', 'python'],
    ]);
    expect(a[0]?.id).toBe(createHash('sha1').update('m1:0').digest('hex'));
    expect(a[2]?.content).toBe('graph TD; A-->B');
    expect(a[4]?.content).toBe(long);
  });

  it('ignores unclosed fences and plain text; the closer must match the opener', () => {
    expect(extractArtifacts('m', 'no code')).toEqual([]);
    expect(extractArtifacts('m', '```html\n<p>open')).toEqual([]);
    expect(extractArtifacts('m', '```html\n<p>x\n~~~')).toEqual([]);
    const nested = extractArtifacts('m', '  ````html\n```\n<p>x\n````');
    expect(nested[0]?.content).toBe('```\n<p>x');
  });

  it('decodes entities and cuts the title at 120 characters', () => {
    const t = extractArtifacts(
      'm',
      '```html\n<h2 class="a">A &amp; B &lt;3&gt; &quot;x&quot;</h2>\n```',
    );
    expect(t[0]?.title).toBe('A & B <3> "x"');
    const long = extractArtifacts('m', `\`\`\`html\n<h1>${'a'.repeat(300)}</h1>\n\`\`\``);
    expect(long[0]?.title).toHaveLength(120);
  });

  it('uses a markdown heading for long markdown', () => {
    const md = `# Plan\n${long}`;
    expect(extractArtifacts('m', `\`\`\`md\n${md}\n\`\`\``)[0]?.title).toBe('Plan');
  });
});
