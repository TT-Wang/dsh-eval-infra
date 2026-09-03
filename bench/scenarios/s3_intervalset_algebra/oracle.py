"""oracle: write the reference implementation (reference_fix.py, the correct
final state after every turn) into the workspace so verify.py can be self-checked."""
import reference_fix


def solve(root):
    reference_fix.apply(root)
