"""oracle: query the four fields straight from the big file."""
import json
import os


def solve(root):
    cat = json.load(open(os.path.join(root, 'data', 'catalog.json')))
    target = next(x for x in cat['items'] if x['id'] == 'SKU-102401')
    answer = {
        'schema_version': cat['meta']['schema_version'],
        'item_count': len(cat['items']),
        'price': target['price'],
        'optics_count': sum(1 for x in cat['items'] if x['category'] == 'optics'),
    }
    json.dump(answer, open(os.path.join(root, 'answer.json'), 'w'), indent=2)
