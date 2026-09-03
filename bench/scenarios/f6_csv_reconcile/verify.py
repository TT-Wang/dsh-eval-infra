import os, json, csv
def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'f6.json'))); problems = []
    try:
        tot = json.load(open(os.path.join(root, 'totals.json')))
        bad = [c for c in t['totals'] if int(tot.get(c, -1)) != t['totals'][c]]
        if bad: problems.append('totals wrong for %s' % bad[:3])
    except Exception as e: problems.append('totals.json missing/unreadable')
    p = os.path.join(root, 'mismatches.csv')
    if not os.path.isfile(p): problems.append('mismatches.csv missing')
    else:
        try:
            got = list(csv.DictReader(open(p)))
            want = t['mismatches']
            gm = {g['sku']: (int(g['wms_qty']), int(g['erp_qty']), int(g['delta'])) for g in got}
            wm = {m['sku']: (m['wms_qty'], m['erp_qty'], m['delta']) for m in want}
            missing = [s for s in wm if s not in gm]; extra = [s for s in gm if s not in wm]; wrong = [s for s in wm if s in gm and gm[s] != wm[s]]
            if missing or extra or wrong: problems.append('mismatches: %d missing, %d extra, %d wrong of %d' % (len(missing), len(extra), len(wrong), len(wm)))
            if [g['sku'] for g in got] != sorted(g['sku'] for g in got): problems.append('mismatches not sorted')
        except Exception as e: problems.append('mismatches.csv unreadable: %s' % str(e)[:60])
    try:
        w = json.load(open(os.path.join(root, 'worst.json')))
        if w.get('sku') != t['worst']['sku'] or int(w.get('abs_delta', -1)) != t['worst']['abs_delta'] or int(w.get('total_abs_delta', -1)) != t['worst']['total_abs_delta']:
            problems.append('worst %s want %s' % (w, t['worst']))
    except Exception: problems.append('worst.json missing/unreadable')
    ok = not problems
    return ok, ('totals + %d mismatches + worst exact' % len(t['mismatches']) if ok else '; '.join(problems)[:400])
