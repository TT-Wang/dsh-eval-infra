import os, random, json
SEED = 20260904
STATUSES = ['completed', 'completed', 'completed', 'completed', 'shipped', 'shipped', 'pending', 'failed', 'cancelled']
ITEMS = ['widget', 'gasket', 'sprocket', 'bearing', 'valve', 'bracket', 'coupling', 'flange']

def generate():
    random.seed(SEED)
    orders = []
    for i in range(2000):
        oid = 'ORD-%06d' % (100000 + i * 7 + random.randint(0, 5))
        amount = round(random.choice([random.uniform(5, 400), random.uniform(400, 2500)]), 2)
        orders.append({'id': oid, 'customer': 'cust-%04d' % random.randint(1, 900), 'status': random.choice(STATUSES), 'amount': amount, 'currency': 'USD',
                       'items': [{'sku': random.choice(ITEMS) + '-%03d' % random.randint(1, 300), 'qty': random.randint(1, 6)} for _ in range(random.randint(1, 3))],
                       'created_at': '2026-08-%02dT%02d:%02d:00Z' % (random.randint(1, 28), random.randint(0, 23), random.randint(0, 59)),
                       'notes': random.choice(['', '', 'gift wrap', 'expedite', 'address verified', 'callback requested'])})
    failed = [o for o in orders if o['status'] == 'failed']
    refunds = []
    refunded = set()
    for o in random.sample(failed, len(failed) // 2):
        refunded.add(o['id'])
        refunds.append({'id': 'RF-%05d' % random.randint(10000, 99999), 'order_id': o['id'], 'amount': o['amount'], 'reason': random.choice(['card declined', 'fraud check', 'customer request'])})
    for o in random.sample([o for o in orders if o['status'] != 'failed'], 60):
        refunds.append({'id': 'RF-%05d' % random.randint(10000, 99999), 'order_id': o['id'], 'amount': round(o['amount'] * random.choice([0.5, 1.0]), 2), 'reason': 'partial return'})
    random.shuffle(refunds)
    target = sorted(o['id'] for o in failed if o['amount'] >= 500 and o['id'] not in refunded)
    total = round(sum(o['amount'] for o in failed if o['amount'] >= 500 and o['id'] not in refunded), 2)
    mx = max(orders, key=lambda o: o['amount'])
    truth = {'order_ids': target, 'total_amount': total, 'orders_total': len(orders), 'max_amount': mx['amount'], 'max_order_id': mx['id'], 'refunds_total': len(refunds)}
    return orders, refunds, truth

API = '''#!/usr/bin/env python3
"""Local order/refund API mirror. Usage:
  python3 api.py orders --page N      (pages start at 1; page_size 100)
  python3 api.py refunds --page N     (page_size 100)
Each response is a JSON object: {"page": N, "page_size": 100, "total_pages": T, "next_page": N+1 or null, "data": [...]}.
"""
import json, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('orders', 'refunds'):
        print(__doc__); sys.exit(2)
    kind = sys.argv[1]
    page = 1
    if '--page' in sys.argv:
        page = int(sys.argv[sys.argv.index('--page') + 1])
    rows = json.load(open(os.path.join(HERE, '.data', kind + '.json')))
    size = 100
    total_pages = (len(rows) + size - 1) // size
    if page < 1 or page > total_pages:
        print(json.dumps({"error": "page out of range", "total_pages": total_pages})); sys.exit(1)
    data = rows[(page - 1) * size: page * size]
    print(json.dumps({"page": page, "page_size": size, "total_pages": total_pages, "next_page": page + 1 if page < total_pages else None, "data": data}, indent=2))
if __name__ == '__main__':
    main()
'''

def setup(root):
    orders, refunds, truth = generate()
    os.makedirs(os.path.join(root, '.data'), exist_ok=True)
    os.makedirs(os.path.join(root, 'docs'), exist_ok=True)
    json.dump(orders, open(os.path.join(root, '.data', 'orders.json'), 'w'))
    json.dump(refunds, open(os.path.join(root, '.data', 'refunds.json'), 'w'))
    open(os.path.join(root, 'api.py'), 'w').write(API)
    open(os.path.join(root, 'docs', 'API.md'), 'w').write('# Order API (local mirror)\n\n```\npython3 api.py orders --page N\npython3 api.py refunds --page N\n```\n\nBoth endpoints are paginated with page_size 100 and return `{"page", "page_size", "total_pages", "next_page", "data"}`.\nOrder fields: id, customer, status (completed|shipped|pending|failed|cancelled), amount (USD, number), currency, items[], created_at, notes.\nRefund fields: id, order_id, amount, reason. A refund "references" an order through order_id.\n')
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    json.dump(truth, open(os.path.join(root, '.truth', 'f2.json'), 'w'), indent=1)
