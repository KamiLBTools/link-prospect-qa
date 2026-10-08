#!/usr/bin/env python3
"""Join QA verdicts back onto the PEPO workbook rows, one output sheet per language.

Reads eval/pepo/results.csv (keyed by normalised domain) and the original
workbook, and writes eval/pepo/PEPO-QA.xlsx preserving every original column
with the QA columns appended. Rows whose domain never produced a verdict keep
the original data and get an empty verdict rather than being dropped.
"""
import csv, re, sys, zipfile, xml.etree.ElementTree as ET
from collections import Counter, OrderedDict

M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS = {'m': M, 'r': R}
SKIP = {'Sheet17', '_EditLog'}
WB = 'Copy DB PEPO.xlsx'
RESULTS = 'eval/pepo/results.csv'
OUT = 'eval/pepo/PEPO-QA.xlsx'
QA_COLS = ['verdict', 'raw_verdict', 'penalty', 'solicits_contributors',
           'stage', 'site_type', 'entity', 'reason']


def norm(s):
    s = (s or '').strip().lower()
    s = re.sub(r'^https?://', '', s)
    s = re.sub(r'^www\.', '', s)
    return s.split('/')[0].split('?')[0].strip()


def read_workbook():
    z = zipfile.ZipFile(WB)
    ss = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')):
            ss.append(''.join(t.text or '' for t in si.iter(f'{{{M}}}t')))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    relmap = {r.get('Id'): r.get('Target')
              for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}

    def cv(c):
        t, v = c.get('t'), c.find('m:v', NS)
        if t == 's':
            return ss[int(v.text)] if v is not None else ''
        if t == 'inlineStr':
            i = c.find('m:is', NS)
            return ''.join(x.text or '' for x in i.iter(f'{{{M}}}t')) if i is not None else ''
        return v.text if v is not None else ''

    def ci(ref):
        n = 0
        for ch in re.match(r'([A-Z]+)', ref).group(1):
            n = n * 26 + ord(ch) - 64
        return n - 1

    sheets = OrderedDict()
    for sh in wb.find('m:sheets', NS):
        name = sh.get('name')
        if name in SKIP:
            continue
        tgt = relmap[sh.get(f'{{{R}}}id')].lstrip('/')
        path = tgt if tgt.startswith('xl/') else 'xl/' + tgt
        s = ET.fromstring(z.read(path))
        rows = []
        for row in s.iter(f'{{{M}}}row'):
            cells = {ci(c.get('r')): cv(c) for c in row.findall('m:c', NS)}
            rows.append([cells.get(i, '') for i in range(max(cells) + 1)] if cells else [])
        sheets[name] = rows
    return sheets


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def colname(n):
    s = ''
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def write_workbook(sheets):
    """Minimal xlsx writer: inline strings only, no shared string table."""
    parts, names = [], list(sheets)
    for idx, name in enumerate(names, 1):
        rows = sheets[name]
        xml = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
               f'<worksheet xmlns="{M}"><sheetData>']
        for ri, row in enumerate(rows, 1):
            if not any(str(c).strip() for c in row):
                continue
            xml.append(f'<row r="{ri}">')
            for cidx, val in enumerate(row):
                if val is None or str(val) == '':
                    continue
                ref = f'{colname(cidx)}{ri}'
                xml.append(f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{esc(val)}</t></is></c>')
            xml.append('</row>')
        xml.append('</sheetData></worksheet>')
        parts.append((f'xl/worksheets/sheet{idx}.xml', ''.join(xml)))

    sheet_tags = ''.join(
        f'<sheet name="{esc(n)}" sheetId="{i}" r:id="rId{i}"/>'
        for i, n in enumerate(names, 1))
    wb_xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              f'<workbook xmlns="{M}" xmlns:r="{R}"><sheets>{sheet_tags}</sheets></workbook>')
    rels = ''.join(
        f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/'
        f'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
        for i in range(1, len(names) + 1))
    wb_rels = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               f'{rels}</Relationships>')
    overrides = ''.join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.'
        f'openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, len(names) + 1))
    ct = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          f'<Default Extension="xml" ContentType="application/xml"/>'
          f'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.'
          f'openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{overrides}</Types>')
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/'
                 '2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')

    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', root_rels)
        z.writestr('xl/workbook.xml', wb_xml)
        z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        for path, body in parts:
            z.writestr(path, body)


def main():
    csv.field_size_limit(10 ** 7)
    with open(RESULTS, newline='', encoding='utf-8') as fh:
        verdicts = {r['domain']: r for r in csv.DictReader(fh)}
    print(f'verdict rows: {len(verdicts)}')

    sheets = read_workbook()
    out, matched, missing = OrderedDict(), 0, 0
    for name, rows in sheets.items():
        if not rows:
            continue
        # Every row is padded to the sheet's full 147-column extent, but only
        # the first ~20 hold anything. Trim to the last column with content so
        # the QA verdict does not land 127 blank columns off-screen.
        width = max((i + 1 for r in rows for i, c in enumerate(r)
                     if str(c).strip()), default=0)

        def fit(row):
            return list(row[:width]) + [''] * (width - len(row[:width]))

        new = [fit(rows[0]) + QA_COLS]
        for row in rows[1:]:
            site = row[2] if len(row) > 2 else ''
            d = norm(site)
            v = verdicts.get(d)
            if site.strip():
                matched += bool(v)
                missing += (not v)
            new.append(fit(row) + [(v or {}).get(c, '') for c in QA_COLS])
        out[name] = new
    write_workbook(out)
    print(f'matched {matched} rows, {missing} rows with no verdict')
    print(f'wrote {OUT}')

    dist = Counter(r['verdict'] for r in verdicts.values())
    print('\n--- VERDICT DISTRIBUTION ---')
    for k, n in dist.most_common():
        print(f'{n:5}  {k or "(none)"}  {n / len(verdicts) * 100:.1f}%')


if __name__ == '__main__':
    main()
