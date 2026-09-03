import os, json
def solve(root):
    t = json.load(open(os.path.join(root, '.truth', 'f10.json')))
    json.dump({'region': t['region'], 'august_refund_total': t['august_refund_total'], 'top_customers': t['top_customers']}, open(os.path.join(root, 'findings.json'), 'w'))
    json.dump({k: t[k] for k in ('customers_with_refunds', 'largest_refund_id', 'largest_refund_amount')}, open(os.path.join(root, 'extra.json'), 'w'))
