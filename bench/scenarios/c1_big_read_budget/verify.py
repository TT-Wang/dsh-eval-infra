import json
import os


def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'c1.json')))
    p = os.path.join(root, 'answer.json')
    if not os.path.isfile(p):
        return False, 'answer.json missing'
    try:
        a = json.load(open(p))
    except Exception:
        return False, 'answer.json is not valid JSON'
    if not isinstance(a, dict):
        return False, 'answer.json is not an object'
    problems = []
    if set(a) != set(t):
        problems.append('keys %s != %s' % (sorted(a), sorted(t)))
    if a.get('schema_version') != t['schema_version']:
        problems.append('schema_version %r != %r' % (a.get('schema_version'), t['schema_version']))
    for k in ('item_count', 'optics_count'):
        v = a.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != t[k] or v != int(v):
            problems.append('%s %r != %d' % (k, v, t[k]))
    v = a.get('price')
    if isinstance(v, bool) or not isinstance(v, (int, float)) or abs(float(v) - t['price']) > 0.005:
        problems.append('price %r != %.2f' % (v, t['price']))
    ok = not problems
    return ok, ('all four values exact' if ok else '; '.join(problems)[:400])
