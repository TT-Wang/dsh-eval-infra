import os
def setup(root):
    with open(os.path.join(root, 'numbers.txt'), 'w') as f:
        f.write('1\n2\n3\n')
