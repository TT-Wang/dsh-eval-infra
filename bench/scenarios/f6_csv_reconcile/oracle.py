import os, json, csv
def solve(root):
    t = json.load(open(os.path.join(root, '.truth', 'f6.json')))
    json.dump(t['totals'], open(os.path.join(root, 'totals.json'), 'w'))
    with open(os.path.join(root, 'mismatches.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['sku', 'wms_qty', 'erp_qty', 'delta']); w.writeheader(); w.writerows(t['mismatches'])
    json.dump(t['worst'], open(os.path.join(root, 'worst.json'), 'w'))
