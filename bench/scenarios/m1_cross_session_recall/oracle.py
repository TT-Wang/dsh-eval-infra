"""oracle: the three deliverables, with every fact (including the chat-only codename)."""
import os

import verify as V


def solve(root):
    os.makedirs(os.path.join(root, 'notes'), exist_ok=True)
    os.makedirs(os.path.join(root, 'scripts'), exist_ok=True)
    six = ''.join('- %s: %s\n' % (k, v) for k, v in V.FACTS[:6])
    open(os.path.join(root, 'notes', 'kickoff.md'), 'w').write('# Kickoff\n' + six)
    open(os.path.join(root, 'scripts', 'hello.py'), 'w').write('print("hello")\n')
    seven = ''.join('- %s: %s\n' % (k, v) for k, v in V.FACTS)
    open(os.path.join(root, 'handoff.md'), 'w').write('# Handoff\n' + seven)
