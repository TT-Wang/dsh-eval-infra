"""oracle:用 ground truth 直接写出正确答案,用来自检 verify。"""
import os, json
def solve(root):
    t = json.load(open(os.path.join(root, '.truth', 'f1.json')))
    rows = ['| service | code | count | first_seen |', '|---|---|---|---|'] + ['| %s | %s | %d | %s |' % (r['service'], r['code'], r['count'], r['first_seen']) for r in t['rows']]
    open(os.path.join(root, 'triage.md'), 'w').write('\n'.join(rows) + '\n\nroot_cause: %s\n' % t['root'])
    open(os.path.join(root, 'warns.txt'), 'w').write('\n'.join(t['warns']) + '\n')
    svc, code = t['root'].split('/')
    first = [r for r in t['rows'] if r['service'] == svc and r['code'] == code][0]['first_seen']
    open(os.path.join(root, 'summary.md'), 'w').write('The checkout incident began when %s hit %s at %s. The failure cascaded through payments, checkout and the gateway. In total %d services logged errors. Mitigation: raise the pool size.\n' % (svc, code, first, t['affected']))
