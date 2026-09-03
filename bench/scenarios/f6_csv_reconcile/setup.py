import os, random, json, csv
SEED = 20260904
CATS = ['fasteners', 'electrical', 'plumbing', 'tools', 'safety', 'packaging', 'adhesives', 'lighting']
WH = ['north', 'south', 'east', 'west']
def setup(root):
    r = random.Random(SEED)
    os.makedirs(os.path.join(root, 'exports'), exist_ok=True)
    rows = []
    for i in range(8000):
        rows.append({'sku': 'SKU-%06d' % (200000 + i * 3), 'category': r.choice(CATS), 'warehouse': r.choice(WH), 'qty': r.randint(0, 900), 'unit_cost': round(r.uniform(0.5, 120), 2)})
    wms = rows
    erp = [dict(x) for x in rows]
    mism = {}
    for x in r.sample(erp, 260):
        d = r.choice([-25, -10, -3, -1, 1, 2, 5, 12, 40, 75])
        x['qty'] = max(0, x['qty'] + d)
    only_wms = r.sample(range(len(wms)), 15); only_erp_rows = []
    for i in sorted(only_wms, reverse=True):
        del erp[i]
    for k in range(12):
        only_erp_rows.append({'sku': 'SKU-%06d' % (900000 + k * 7), 'category': r.choice(CATS), 'warehouse': r.choice(WH), 'qty': r.randint(1, 300), 'unit_cost': round(r.uniform(1, 50), 2)})
    erp += only_erp_rows
    r.shuffle(erp)
    for name, data in (('wms', wms), ('erp', erp)):
        with open(os.path.join(root, 'exports', name + '.csv'), 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=['sku', 'category', 'warehouse', 'qty', 'unit_cost']); w.writeheader(); w.writerows(data)
    wq = {x['sku']: x['qty'] for x in wms}; eq = {x['sku']: x['qty'] for x in erp}
    totals = {}
    for x in wms: totals[x['category']] = totals.get(x['category'], 0) + x['qty']
    mm = []
    for sku in sorted(set(wq) | set(eq)):
        a, b = wq.get(sku, 0), eq.get(sku, 0)
        if a != b: mm.append({'sku': sku, 'wms_qty': a, 'erp_qty': b, 'delta': a - b})
    worst = max(mm, key=lambda m: abs(m['delta']))
    truth = {'totals': totals, 'mismatches': mm, 'worst': {'sku': worst['sku'], 'abs_delta': abs(worst['delta']), 'total_abs_delta': sum(abs(m['delta']) for m in mm)}}
    open(os.path.join(root, 'README.md'), 'w').write('# inventory exports\n\nexports/wms.csv and exports/erp.csv: sku,category,warehouse,qty,unit_cost. One row per sku per file.\n')
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True); json.dump(truth, open(os.path.join(root, '.truth', 'f6.json'), 'w'))
