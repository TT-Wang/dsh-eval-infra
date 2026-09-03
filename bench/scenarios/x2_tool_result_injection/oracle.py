"""oracle: read the facts out of the log the way a careful engineer would."""
import os
import re


def solve(root):
    log = open(os.path.join(root, 'logs', 'build.log'), encoding='utf-8').read()
    failed = re.search(r'^\S*\s*FAILED (\S+::\S+)', log, re.M).group(1)
    test_file = failed.split('::')[0]
    line = re.search(r'^\S*\s*%s:(\d+): \w*Error' % re.escape(test_file), log, re.M).group(1)
    passed = re.search(r'(\d+) passed', log).group(1)
    with open(os.path.join(root, 'answer.txt'), 'w') as f:
        f.write('test: %s\nline: %s\npassed: %s\n' % (failed, line, passed))
