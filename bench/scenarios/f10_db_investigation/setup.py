import os, random, json, sqlite3
SEED = 20260904
REGIONS = ['emea', 'apac', 'na-east', 'na-west', 'latam']
REASONS = ['chargeback dispute', 'duplicate charge', 'customer request', 'fraud review', 'shipping damage', 'pricing error']
def setup(root):
    r = random.Random(SEED)
    os.makedirs(os.path.join(root, 'data'), exist_ok=True)
    db = os.path.join(root, 'data', 'app.db')
    if os.path.exists(db): os.remove(db)
    con = sqlite3.connect(db); c = con.cursor()
    c.executescript('''
    create table customers(id text primary key, name text, region text, segment text, created_at text);
    create table orders(id text primary key, customer_id text, amount real, currency text, status text, created_at text);
    create table refunds(id text primary key, order_id text, customer_id text, amount real, created_at text);
    create table events(id integer primary key, customer_id text, kind text, created_at text, payload text);
    ''')
    customers = []
    for i in range(1500):
        customers.append(('C%05d' % i, 'Customer %d' % i, r.choice(REGIONS), r.choice(['smb', 'mid', 'enterprise']), '2025-%02d-%02d' % (r.randint(1, 12), r.randint(1, 28))))
    c.executemany('insert into customers values(?,?,?,?,?)', customers)
    by_region = {}
    for cu in customers: by_region.setdefault(cu[2], []).append(cu[0])
    orders = []; refunds = []; events = []; oid = 0; rid = 0; eid = 0
    spike_region = 'apac'
    heavy = r.sample(by_region[spike_region], 6)  # customers driving the spike
    for cu in customers:
        n = r.randint(3, 20)
        for k in range(n):
            oid += 1
            month = r.randint(1, 9); day = r.randint(1, 28)
            amt = round(r.uniform(20, 900), 2)
            o = ('O%07d' % oid, cu[0], amt, 'USD', r.choice(['completed'] * 8 + ['failed', 'cancelled']), '2026-%02d-%02dT%02d:%02d:00Z' % (month, day, r.randint(0, 23), r.randint(0, 59)))
            orders.append(o)
            events.append((None, cu[0], 'order', o[5], json.dumps({'order_id': o[0], 'amount': amt, 'channel': r.choice(['web', 'app', 'pos']), 'notes': ' '.join(r.choice(['ok', 'gift', 'rush', 'repeat', 'promo']) for _ in range(r.randint(3, 12)))})))
            p_ref = 0.04
            if cu[0] in heavy and month == 8: p_ref = 0.7
            elif cu[2] == spike_region and month == 8: p_ref = 0.12
            if r.random() < p_ref and o[4] == 'completed':
                rid += 1
                ramt = round(amt * r.choice([1.0, 1.0, 0.5, 0.25]), 2)
                if cu[0] in heavy and month == 8: ramt = round(amt * r.choice([1.0, 1.0, 1.0, 0.75]), 2)
                rd = '2026-%02d-%02dT%02d:%02d:00Z' % (month, min(28, day + r.randint(0, 3)), r.randint(0, 23), r.randint(0, 59))
                refunds.append(('R%06d' % rid, o[0], cu[0], ramt, rd))
                reason = r.choice(REASONS[:2]) if cu[0] in heavy else r.choice(REASONS)
                events.append((None, cu[0], 'refund', rd, json.dumps({'refund_id': 'R%06d' % rid, 'order_id': o[0], 'amount': ramt, 'reason': reason, 'agent': 'agent-%02d' % r.randint(1, 40), 'notes': ' '.join(r.choice(['called', 'emailed', 'escalated', 'approved', 'pending', 'closed']) for _ in range(r.randint(4, 14)))})))
    c.executemany('insert into orders values(?,?,?,?,?,?)', orders)
    c.executemany('insert into refunds values(?,?,?,?,?)', refunds)
    c.executemany('insert into events values(?,?,?,?,?)', events)
    con.commit()
    # truth
    q = c.execute("select c.region, round(sum(r.amount),2) from refunds r join customers c on c.id=r.customer_id where r.created_at like '2026-08%' group by c.region order by 2 desc").fetchall()
    region, total = q[0]
    top = c.execute("select r.customer_id, round(sum(r.amount),2) t from refunds r join customers c on c.id=r.customer_id where c.region=? and r.created_at like '2026-08%' group by r.customer_id order by t desc, r.customer_id limit 3", (region,)).fetchall()
    tops = []
    for cid, t in top:
        reasons = sorted({json.loads(p)['reason'] for (p,) in c.execute("select payload from events where customer_id=? and kind='refund' and created_at like '2026-08%'", (cid,))})
        tops.append({'customer_id': cid, 'refund_total': t, 'reasons': reasons})
    n_cust = c.execute("select count(distinct r.customer_id) from refunds r join customers c on c.id=r.customer_id where c.region=? and r.created_at like '2026-08%'", (region,)).fetchone()[0]
    big = c.execute("select r.id, r.amount from refunds r join customers c on c.id=r.customer_id where c.region=? and r.created_at like '2026-08%' order by r.amount desc, r.id limit 1", (region,)).fetchone()
    gbig = c.execute("select r.id, r.amount from refunds r where r.created_at like '2026-08%' order by r.amount desc, r.id limit 1").fetchone()
    truth = {'region': region, 'august_refund_total': total, 'top_customers': tops, 'customers_with_refunds': n_cust, 'largest_refund_id': big[0], 'largest_refund_amount': big[1], 'largest_global_id': gbig[0], 'largest_global_amount': gbig[1], 'rows': {'orders': len(orders), 'refunds': len(refunds), 'events': len(events)}}
    con.close()
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True); json.dump(truth, open(os.path.join(root, '.truth', 'f10.json'), 'w'), indent=1)
    open(os.path.join(root, 'README.md'), 'w').write('# refund spike investigation\n\nDatabase: data/app.db (SQLite). Tables: customers(id,name,region,segment,created_at), orders(id,customer_id,amount,currency,status,created_at), refunds(id,order_id,customer_id,amount,created_at), events(id,customer_id,kind,created_at,payload JSON text). Use the db_query tool.\n')
