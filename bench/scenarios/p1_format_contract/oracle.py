"""oracle: the exact deliverables of all three turns, computed from the CSV."""
import csv
import json
import os

import setup as S


def solve(root):
    rows = list(csv.DictReader(open(os.path.join(root, 'data', 'orders.csv'), newline='')))
    t = S.compute_truth(rows)
    out = os.path.join(root, 'out')
    os.makedirs(out, exist_ok=True)
    summary = {k: t[k] for k in ('order_count', 'total_revenue', 'regions', 'status_counts', 'top_customers')}
    json.dump(summary, open(os.path.join(out, 'summary.json'), 'w'), indent=2)
    lines = ['# Orders Report', '', '## Totals', '- Orders: %d' % t['order_count'], '- Revenue: %.2f' % t['total_revenue'], '',
             '## By Region', '| Region | Orders | Revenue |', '|---|---|---|']
    lines += ['| %s | %d | %.2f |' % (b['region'], b['orders'], b['revenue']) for b in t['by_region']]
    lines += ['', '## Top Customers']
    lines += ['%d. %s: %.2f' % (i + 1, c['customer'], c['revenue']) for i, c in enumerate(t['top_customers'])]
    open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines) + '\n')
    open(os.path.join(out, 'regions.txt'), 'w').write('\n'.join(t['regions']) + '\n')
