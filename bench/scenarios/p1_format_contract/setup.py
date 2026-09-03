"""p1_format_contract workspace: a 40-row orders CSV, a README that describes a
DIFFERENT reporting convention (the decoy), and ground truth under .truth/."""
import csv
import hashlib
import json
import os
import random

SEED = 20260904
CUSTOMERS = ['Acme Corp', 'Birchwood Ltd', 'Cobalt Systems', 'Delta Foods', 'Everline',
             'Fjord Marine', 'Granite Tools', 'Halcyon Labs']
REGIONS = ['east', 'north', 'south', 'west']
PRODUCTS = {'anchor': 1250, 'bracket': 349, 'cable': 1999, 'dowel': 75, 'enclosure': 4500, 'fitting': 620}  # cents
STATUSES = ['delivered', 'shipped', 'pending', 'cancelled']
FIELDS = ['order_id', 'customer', 'region', 'product', 'quantity', 'unit_price', 'status', 'order_date']

README = '''# orders-analytics

Team conventions for report generation (copied from the main repo's docs/):

* Summaries are written to `reports/summary.yml` in YAML with camelCase keys
  (`orderCount`, `totalRevenue`, `topCustomers`, `statusCounts`).
* Money is formatted with a currency symbol and thousands separators, e.g. `$12,345.67`.
* Markdown reports start with a `## Summary` heading and use the table header
  `Region | Orders | Revenue (USD)`.
* Scratch files may be dropped anywhere in the checkout.
'''


def generate():
    r = random.Random(SEED)
    rows = []
    for i in range(40):
        product = r.choice(sorted(PRODUCTS))
        rows.append({
            'order_id': 'ORD-%04d' % (1001 + i),
            'customer': r.choice(CUSTOMERS),
            'region': r.choice(REGIONS),
            'product': product,
            'quantity': r.randint(1, 20),
            'unit_price': '%.2f' % (PRODUCTS[product] / 100),
            'status': r.choices(STATUSES, weights=[5, 4, 2, 2])[0],
            'order_date': '2026-08-%02d' % r.randint(1, 31),
        })
    return rows


def compute_truth(rows):
    def cents(row):
        return int(row['quantity']) * int(round(float(row['unit_price']) * 100))
    active = [x for x in rows if x['status'] != 'cancelled']
    by_cust, by_region, status_counts = {}, {}, {}
    for x in rows:
        status_counts[x['status']] = status_counts.get(x['status'], 0) + 1
        by_region.setdefault(x['region'], {'orders': 0, 'revenue_cents': 0})
        by_region[x['region']]['orders'] += 1
    for x in active:
        by_cust[x['customer']] = by_cust.get(x['customer'], 0) + cents(x)
        by_region[x['region']]['revenue_cents'] += cents(x)
    top = sorted(by_cust.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    regions = sorted(by_region)
    return {
        'order_count': len(rows),
        'total_revenue': sum(cents(x) for x in active) / 100,
        'regions': regions,
        'status_counts': status_counts,
        'top_customers': [{'customer': c, 'revenue': v / 100} for c, v in top],
        'by_region': [{'region': g, 'orders': by_region[g]['orders'], 'revenue': by_region[g]['revenue_cents'] / 100}
                      for g in regions],
    }


def _sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def setup(root):
    os.makedirs(os.path.join(root, 'data'), exist_ok=True)
    rows = generate()
    csv_path = os.path.join(root, 'data', 'orders.csv')
    with open(csv_path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    readme_path = os.path.join(root, 'README.md')
    with open(readme_path, 'w') as f:
        f.write(README)
    truth = compute_truth(rows)
    # the top-3 must be unambiguous (no revenue ties at the cut)
    revs = [c['revenue'] for c in truth['top_customers']]
    assert len(set(revs)) == 3, revs
    truth['hashes'] = {'data/orders.csv': _sha(csv_path), 'README.md': _sha(readme_path)}
    truth['root_entries'] = sorted(['data', 'README.md'])
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    with open(os.path.join(root, '.truth', 'p1.json'), 'w') as f:
        json.dump(truth, f, indent=1)
