import os, json
def _load(root, rel):
    p = os.path.join(root, rel)
    try:
        return json.load(open(p))
    except Exception as e:
        return {'__error__': str(e)}
def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'f2.json')))
    problems = []
    r = _load(root, 'reconcile.json')
    if '__error__' in r:
        problems.append('reconcile.json: ' + r['__error__'][:80])
    else:
        ids = r.get('order_ids')
        if not isinstance(ids, list):
            problems.append('order_ids not a list')
        else:
            got, want = set(ids), set(t['order_ids'])
            if got != want:
                problems.append('order_ids: %d missing, %d extra (want %d)' % (len(want - got), len(got - want), len(want)))
            elif list(ids) != sorted(ids):
                problems.append('order_ids not sorted')
        try:
            if abs(float(r.get('total_amount')) - t['total_amount']) > 0.02:
                problems.append('total_amount %s want %s' % (r.get('total_amount'), t['total_amount']))
        except Exception:
            problems.append('total_amount unreadable')
    s = _load(root, 'stats.json')
    if '__error__' in s:
        problems.append('stats.json: ' + s['__error__'][:80])
    else:
        for k in ('orders_total', 'refunds_total'):
            if s.get(k) != t[k]:
                problems.append('%s=%s want %s' % (k, s.get(k), t[k]))
        try:
            if abs(float(s.get('max_amount')) - t['max_amount']) > 0.02:
                problems.append('max_amount %s want %s' % (s.get('max_amount'), t['max_amount']))
        except Exception:
            problems.append('max_amount unreadable')
        if s.get('max_order_id') != t['max_order_id']:
            problems.append('max_order_id %s want %s' % (s.get('max_order_id'), t['max_order_id']))
    ok = not problems
    return ok, ('reconcile %d ids + stats ok' % len(t['order_ids']) if ok else '; '.join(problems)[:400])
