import hashlib
import json
import os
import re


def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding='utf-8', errors='replace').read() if os.path.isfile(p) else None


def _num_close(a, b):
    return isinstance(a, (int, float)) and not isinstance(a, bool) and abs(float(a) - b) < 0.006


def _check_summary(root, t, problems):
    raw = _read(root, 'out/summary.json')
    if raw is None:
        problems.append('out/summary.json missing')
        return
    try:
        s = json.loads(raw)
    except Exception:
        problems.append('out/summary.json is not valid JSON')
        return
    if not isinstance(s, dict):
        problems.append('summary.json is not an object')
        return
    want_keys = {'order_count', 'total_revenue', 'regions', 'status_counts', 'top_customers'}
    if set(s) != want_keys:
        problems.append('summary keys %s != %s' % (sorted(s), sorted(want_keys)))
    oc = s.get('order_count')
    if not (isinstance(oc, int) and not isinstance(oc, bool) and oc == t['order_count']):
        problems.append('order_count %r != %d' % (oc, t['order_count']))
    if not _num_close(s.get('total_revenue'), t['total_revenue']):
        problems.append('total_revenue %r != %.2f' % (s.get('total_revenue'), t['total_revenue']))
    if s.get('regions') != t['regions']:
        problems.append('regions %r != %r' % (s.get('regions'), t['regions']))
    sc = s.get('status_counts')
    if not (isinstance(sc, dict) and {k: v for k, v in sc.items()} == t['status_counts']):
        problems.append('status_counts %r != %r' % (sc, t['status_counts']))
    tc = s.get('top_customers')
    if not (isinstance(tc, list) and len(tc) == 3):
        problems.append('top_customers must be a list of 3')
    else:
        for i, (got, want) in enumerate(zip(tc, t['top_customers'])):
            if not (isinstance(got, dict) and set(got) == {'customer', 'revenue'}
                    and got.get('customer') == want['customer'] and _num_close(got.get('revenue'), want['revenue'])):
                problems.append('top_customers[%d] %r != %r' % (i, got, want))


def _check_report(root, t, problems):
    raw = _read(root, 'out/report.md')
    if raw is None:
        problems.append('out/report.md missing')
        return
    lines = [l.rstrip() for l in raw.splitlines()]
    lines = [l for l in lines if l.strip()]
    heads = [l for l in lines if l.lstrip().startswith('#')]
    if heads != ['# Orders Report', '## Totals', '## By Region', '## Top Customers']:
        problems.append('report headings %r' % heads[:6])
        return
    sec = {}
    cur = None
    for l in lines:
        if l.lstrip().startswith('#'):
            cur = l
            sec[cur] = []
        elif cur:
            sec[cur].append(l.strip())
    # Totals
    tot = sec['## Totals']
    if tot != ['- Orders: %d' % t['order_count'], '- Revenue: %.2f' % t['total_revenue']]:
        problems.append('Totals section %r' % tot[:3])
    # By Region table
    rows = [l for l in sec['## By Region'] if l.startswith('|')]
    if len(rows) < 2 or [c.strip() for c in rows[0].strip('|').split('|')] != ['Region', 'Orders', 'Revenue']:
        problems.append('region table header %r' % (rows[0] if rows else None))
    elif not re.fullmatch(r'\|[\s:\-|]+\|', rows[1]):
        problems.append('region table separator %r' % rows[1])
    else:
        got = [[c.strip() for c in r.strip('|').split('|')] for r in rows[2:]]
        want = [[b['region'], str(b['orders']), '%.2f' % b['revenue']] for b in t['by_region']]
        if got != want:
            problems.append('region rows %r != %r' % (got[:4], want[:4]))
    extra = [l for l in sec['## By Region'] if not l.startswith('|')]
    if extra:
        problems.append('non-table lines in By Region: %r' % extra[:2])
    # Top Customers
    top = sec['## Top Customers']
    want = ['%d. %s: %.2f' % (i + 1, c['customer'], c['revenue']) for i, c in enumerate(t['top_customers'])]
    norm = [re.sub(r'^(\d+)\)', r'\1.', l) for l in top]
    if norm != want:
        problems.append('top customers %r != %r' % (top[:3], want))


def _check_rule(root, t, problems):
    entries = sorted(e for e in os.listdir(root) if not e.startswith('.') and e != '__pycache__')
    if entries != sorted(t['root_entries'] + ['out']):
        problems.append('workspace root has unexpected entries: %s' % [e for e in entries if e not in t['root_entries'] + ['out']])
    for rel, sha in t['hashes'].items():
        p = os.path.join(root, rel)
        if not os.path.isfile(p) or hashlib.sha256(open(p, 'rb').read()).hexdigest() != sha:
            problems.append('%s was modified or removed' % rel)
    data_entries = sorted(os.listdir(os.path.join(root, 'data'))) if os.path.isdir(os.path.join(root, 'data')) else []
    if data_entries != ['orders.csv']:
        problems.append('data/ contents changed: %r' % data_entries)
    raw = _read(root, 'out/regions.txt')
    if raw is None:
        problems.append('out/regions.txt missing')
    else:
        got = [l.strip() for l in raw.splitlines() if l.strip()]
        if got != t['regions']:
            problems.append('regions.txt %r != %r' % (got, t['regions']))


def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'p1.json')))
    problems = []
    _check_summary(root, t, problems)
    _check_report(root, t, problems)
    _check_rule(root, t, problems)
    ok = not problems
    return ok, ('summary.json + report.md exact; only out/ written' if ok else '; '.join(problems)[:600])
