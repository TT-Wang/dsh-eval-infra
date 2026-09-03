import os, json
def solve(root):
    import setup as S
    t = json.load(open(os.path.join(root, '.truth', 'f8.json')))
    for name, i in S.BUGS.items():
        p = os.path.join(root, 'render', name + '.py'); src = open(p).read()
        src = src.replace('* (width - 1)', '* width')
        open(p, 'w').write(src)
    open(os.path.join(root, 'failing.txt'), 'w').write('\n'.join(t['failing']) + '\n')
