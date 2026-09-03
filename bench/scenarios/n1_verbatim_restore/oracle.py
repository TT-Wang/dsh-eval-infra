"""oracle: final state of n1_verbatim_restore.

The dictated policy (turn 1, chat only) is restored verbatim into
restored/policy.md (turn 11); lib/util.py gains count_tag (turn 2) and the
SESSION_COMPLETE marker (turn 12).
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

UTIL_ADDITION = '''

def count_tag(text, tag):
    """Count the lines of text that start with tag."""
    return sum(1 for line in text.splitlines() if line.startswith(tag))


SESSION_COMPLETE = True
'''


def solve(root):
    prompts = json.load(open(os.path.join(HERE, "prompts.json"), encoding="utf-8"))
    policy = prompts[0].split("\n\n", 1)[1].strip()        # everything after the instruction paragraph
    os.makedirs(os.path.join(root, "restored"), exist_ok=True)
    with open(os.path.join(root, "restored", "policy.md"), "w", encoding="utf-8") as f:
        f.write(policy + "\n")
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    with open(os.path.join(root, "lib", "util.py"), "a", encoding="utf-8") as f:
        f.write(UTIL_ADDITION)
