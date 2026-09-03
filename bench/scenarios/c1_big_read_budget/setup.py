"""c1_big_read_budget workspace: one ~400 KB JSON catalog (the answer needs four
fields of it), a small look-alike sample file (the decoy), and the truth."""
import json
import os
import random

SEED = 20260904
CATEGORIES = ['optics', 'fasteners', 'electrical', 'plumbing', 'tools', 'safety', 'packaging', 'adhesives']
WORDS = ['alloy', 'bracket', 'carbon', 'dual', 'edge', 'flux', 'grip', 'hex', 'inline', 'jet', 'kit', 'lens',
         'mount', 'nano', 'orbit', 'pro', 'quad', 'rail', 'seal', 'torque', 'ultra', 'vent', 'wide', 'zinc']
TARGET = 'SKU-102401'


def _item(r, i):
    sku = 'SKU-%06d' % (100000 + i * 3 + 1)
    name = ' '.join(r.choice(WORDS) for _ in range(3)).title()
    notes = ' '.join(r.choice(WORDS) for _ in range(22))
    return {
        'id': sku,
        'name': name,
        'category': r.choice(CATEGORIES),
        'price': round(r.uniform(1.5, 950.0), 2),
        'stock': r.randint(0, 5000),
        'tags': sorted(set(r.choice(WORDS) for _ in range(3))),
        'supplier': 'SUP-%03d' % r.randint(1, 60),
        'notes': notes,
    }


def generate():
    r = random.Random(SEED)
    items = [_item(r, i) for i in range(1200)]
    return {
        'meta': {'schema_version': '7.4.2', 'generated_at': '2026-09-01T00:00:00Z', 'source': 'erp-export'},
        'items': items,
    }


def setup(root):
    os.makedirs(os.path.join(root, 'data'), exist_ok=True)
    cat = generate()
    assert any(x['id'] == TARGET for x in cat['items'])
    with open(os.path.join(root, 'data', 'catalog.json'), 'w') as f:
        json.dump(cat, f, indent=1)
    # decoy: a small sample with the same shape, a different schema version and a
    # DIFFERENT price for the target sku
    r = random.Random(SEED + 1)
    sample_items = [dict(x) for x in cat['items'][:20]]
    for x in sample_items:
        x['price'] = round(x['price'] * 0.9, 2)
    target = next(x for x in cat['items'] if x['id'] == TARGET)
    tcopy = dict(target)
    tcopy['price'] = round(target['price'] + 11.11, 2)
    sample_items.append(tcopy)
    sample = {'meta': {'schema_version': '7.3.0', 'generated_at': '2026-06-01T00:00:00Z', 'source': 'sample'},
              'items': sample_items}
    with open(os.path.join(root, 'data', 'catalog.sample.json'), 'w') as f:
        json.dump(sample, f, indent=1)
    with open(os.path.join(root, 'README.md'), 'w') as f:
        f.write('# catalog export\n\ndata/catalog.json is the full ERP export; data/catalog.sample.json is a '
                'trimmed sample kept for documentation.\n')
    truth = {
        'schema_version': cat['meta']['schema_version'],
        'item_count': len(cat['items']),
        'price': target['price'],
        'optics_count': sum(1 for x in cat['items'] if x['category'] == 'optics'),
    }
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    json.dump(truth, open(os.path.join(root, '.truth', 'c1.json'), 'w'))
