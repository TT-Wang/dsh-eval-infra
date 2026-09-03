import os, json
def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'f10.json'))); problems = []
    try: f = json.load(open(os.path.join(root, 'findings.json')))
    except Exception as e: return False, 'findings.json missing/unreadable: %s' % str(e)[:60]
    if str(f.get('region', '')).lower() != t['region']: problems.append('region %s want %s' % (f.get('region'), t['region']))
    try:
        if abs(float(f.get('august_refund_total')) - t['august_refund_total']) > 0.05: problems.append('total %s want %s' % (f.get('august_refund_total'), t['august_refund_total']))
    except Exception: problems.append('total unreadable')
    got = f.get('top_customers') or []
    want = t['top_customers']
    if [g.get('customer_id') for g in got] != [w['customer_id'] for w in want]: problems.append('top customers %s want %s' % ([g.get('customer_id') for g in got], [w['customer_id'] for w in want]))
    else:
        for g, w in zip(got, want):
            try:
                if abs(float(g.get('refund_total')) - w['refund_total']) > 0.05: problems.append('%s total %s want %s' % (w['customer_id'], g.get('refund_total'), w['refund_total']))
            except Exception: problems.append('%s total unreadable' % w['customer_id'])
            if sorted(str(x).lower() for x in (g.get('reasons') or [])) != w['reasons']: problems.append('%s reasons %s want %s' % (w['customer_id'], g.get('reasons'), w['reasons']))
    try:
        e = json.load(open(os.path.join(root, 'extra.json')))
        if int(e.get('customers_with_refunds', -1)) != t['customers_with_refunds']: problems.append('customers_with_refunds %s want %s' % (e.get('customers_with_refunds'), t['customers_with_refunds']))
        # 接受两种读法:区域内最大(题意)或全局最大(早期措辞"region-wide"被两臂都读成全局)
        ok_region = e.get('largest_refund_id') == t['largest_refund_id'] and abs(float(e.get('largest_refund_amount', -1)) - t['largest_refund_amount']) <= 0.05
        ok_global = 'largest_global_id' in t and e.get('largest_refund_id') == t['largest_global_id'] and abs(float(e.get('largest_refund_amount', -1)) - t['largest_global_amount']) <= 0.05
        if not (ok_region or ok_global): problems.append('largest %s want %s/%s' % (e, t['largest_refund_id'], t['largest_refund_amount']))
    except Exception: problems.append('extra.json missing/unreadable')
    ok = not problems
    return ok, ('region, total, top-3 with reasons, extras all exact' if ok else '; '.join(problems)[:400])
