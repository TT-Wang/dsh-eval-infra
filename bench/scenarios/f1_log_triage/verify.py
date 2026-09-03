import os, re, json

def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding='utf-8', errors='replace').read() if os.path.isfile(p) else None

def verify(root):
    truth = json.load(open(os.path.join(root, '.truth', 'f1.json')))
    problems = []
    tri = _read(root, 'triage.md')
    if tri is None:
        problems.append('triage.md missing')
    else:
        rows = {}
        for line in tri.splitlines():
            cells = [c.strip() for c in line.strip().strip('|').split('|')]
            if len(cells) >= 4 and cells[1].startswith('E-'):
                m = re.search(r'\d+', cells[2])
                rows[(cells[0], cells[1])] = (int(m.group(0)) if m else None, cells[3])
        for r in truth['rows']:
            got = rows.get((r['service'], r['code']))
            if got is None:
                problems.append('missing row %s/%s' % (r['service'], r['code']))
            else:
                if got[0] != r['count']:
                    problems.append('count %s/%s=%s want %s' % (r['service'], r['code'], got[0], r['count']))
                if r['first_seen'] not in got[1]:
                    problems.append('first_seen %s/%s' % (r['service'], r['code']))
        extra = [k for k in rows if not any(k == (r['service'], r['code']) for r in truth['rows'])]
        if extra:
            problems.append('extra rows %s' % extra[:3])
        m = re.search(r'root_cause:\s*([\w\-]+)/([\w\-]+)', tri)
        if not m or '%s/%s' % (m.group(1), m.group(2)) != truth['root']:
            problems.append('root_cause wrong or missing')
    w = _read(root, 'warns.txt')
    if w is None:
        problems.append('warns.txt missing')
    else:
        got = [l.strip() for l in w.splitlines() if l.strip()]
        if got != truth['warns']:
            problems.append('warns mismatch: got %d lines, want %d; first got=%r' % (len(got), len(truth['warns']), got[0][:60] if got else None))
    s = _read(root, 'summary.md')
    if s is None:
        problems.append('summary.md missing')
    else:
        svc, code = truth['root'].split('/')
        first = [r for r in truth['rows'] if r['service'] == svc and r['code'] == code][0]['first_seen']
        if svc not in s or code not in s:
            problems.append('summary lacks root cause')
        if first not in s and first[:19] not in s:
            problems.append('summary lacks first timestamp')
        if str(truth['affected']) not in s:
            problems.append('summary lacks affected count %d' % truth['affected'])
    ok = not problems
    return ok, ('triage ok; warns ok; summary ok' if ok else '; '.join(problems)[:400])
