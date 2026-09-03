import os
def verify(root):
    p = os.path.join(root, 'answer.txt')
    if not os.path.exists(p):
        return False, 'answer.txt missing'
    lines = open(p).read().split('\n')
    if lines[0].strip() != '6':
        return False, 'wrong sum: %r' % lines[0]
    if 'DONE' not in lines:
        return False, 'DONE missing'
    return True, 'ok'
