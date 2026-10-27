import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractArtifacts } from './artifacts.ts';

const long = Array.from({ length: 40 }, (_, i) => `x = ${i}`).join('\n');

describe('extractArtifacts', () => {
  it('picks the five fences; code of any length is no artifact', () => {
    const text = [
      'Intro',
      '```html\n<html><h1>My <b>page</b></h1></html>\n```',
      '```python\nprint(1)\n```',
      '```tsx\nexport default () => <div/>;\n```',
      '```jsx\nexport default () => <h1>Kortti</h1>;\n```',
      '~~~mermaid\ngraph TD; A-->B\n~~~',
      '```mermaid\nflowchart TD\n  accTitle: Loma & kesä\n  A-->B\n```',
      '```vega-lite\n{"title": {"text": ["Myynti", "2026"]}, "mark": "bar"}\n```',
      `\`\`\`python\n${long}\n\`\`\``,
    ].join('\n\n');
    const a = extractArtifacts('m1', text);
    expect(a.map((x) => [x.kind, x.title, x.language])).toEqual([
      ['html', 'My page', 'html'],
      ['react', 'tsx #2', 'tsx'],
      ['react', 'Kortti', 'jsx'],
      ['mermaid', 'mermaid #4', 'mermaid'],
      ['mermaid', 'Loma & kesä', 'mermaid'],
      ['vega-lite', 'Myynti 2026', 'vega-lite'],
    ]);
    expect(a[0]?.id).toBe(createHash('sha1').update('m1:0').digest('hex'));
    expect(a[3]?.content).toBe('graph TD; A-->B');
  });

  it('gives masked and restored text the same ids; code between does not shift them', () => {
    const text = (name: string) =>
      [
        `\`\`\`python\nprint("${name}")\n${long}\n\`\`\``,
        `\`\`\`html\n<p>${name}</p>\n\`\`\``,
        `\`\`\`mermaid\ngraph TD; A[${name}]-->B\n\`\`\``,
      ].join('\n\n');
    const masked = extractArtifacts('m1', text('Pekka Laaksonen'));
    const real = extractArtifacts('m1', text('Matti Virtanen'));
    expect(real.map((a) => a.id)).toEqual(masked.map((a) => a.id));
    expect(real.map((a) => a.id)).toEqual(
      ['m1:0', 'm1:1'].map((k) => createHash('sha1').update(k).digest('hex')),
    );
    expect(real[0]?.content).toBe('<p>Matti Virtanen</p>');
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
});
