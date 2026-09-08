/**
 * The contract a public-benchmark adapter fulfils: a dataset's task index,
 * what each task needs (image, size, platform), and how one task becomes a
 * scenario directory — nothing is downloaded until a task is picked.
 */
import { join, resolve, sep } from 'node:path';
/**
 * The directory of one task inside a pool. A task id is one path segment; anything else (a path, `..`, an
 * absolute name) is refused here so no adapter can be talked into removing or writing outside its pool.
 */
export function taskDir(pool, id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes('..'))
        throw new Error(`invalid task id ${JSON.stringify(id)}: one path segment of letters, digits, . _ -`);
    const dir = resolve(pool, id);
    const root = resolve(pool);
    if (dir !== join(root, id) || !dir.startsWith(root + sep))
        throw new Error(`task ${id} resolves outside the pool ${pool}`);
    return dir;
}
/** What Docker Hub knows about an image tag: the platforms it is built for and its compressed size. Null when it does not answer. */
export async function dockerHubImage(image, fetcher = defaultFetch) {
    const m = /^([^:]+):(.+)$/.exec(image);
    if (!m)
        return null;
    const repo = m[1].includes('/') ? m[1] : `library/${m[1]}`;
    try {
        const d = JSON.parse(await fetcher(`https://hub.docker.com/v2/repositories/${repo}/tags/${m[2]}`));
        const images = (d.images ?? []).filter(i => i.size > 0);
        if (images.length === 0)
            return null;
        const platforms = [...new Set(images.map(i => i.architecture))].filter((a) => a === 'amd64' || a === 'arm64');
        return { platforms, sizeMb: Math.round(Math.max(...images.map(i => i.size)) / 1e6) };
    }
    catch {
        return null;
    }
}
/** Pull an image unless it is already present: a registry that will not answer must not block a task whose image is on the machine. */
export async function ensureImage(image, docker, log, sizeNote = '') {
    const present = await docker(['image', 'inspect', image]);
    if (present.code === 0) {
        log(`${image} is already on this machine`);
        return;
    }
    log(`pulling ${image} (linux/amd64${sizeNote})…`);
    let pulled = await docker(['pull', '--platform', 'linux/amd64', image]);
    if (pulled.code !== 0) {
        await new Promise(r => setTimeout(r, 3000));
        pulled = await docker(['pull', '--platform', 'linux/amd64', image]);
    }
    if (pulled.code !== 0)
        throw new Error(`docker pull ${image} failed: ${pulled.stderr.trim().split('\n').at(-1) ?? pulled.code}`);
}
/** Plain GET with three attempts: an index is dozens of small files, and one dropped connection must not fail it. */
export async function defaultFetch(url) {
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            // A GitHub token, when the environment has one (CI usually does), lifts the API's 60-an-hour anonymous limit.
            const token = url.startsWith('https://api.github.com/') ? (process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']) : undefined;
            const res = await fetch(url, { headers: { 'user-agent': 'dsh-eval', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
            if (res.status === 404)
                throw new Error(`${url}: HTTP 404`);
            if (!res.ok)
                throw new Error(`${url}: HTTP ${res.status}`);
            return await res.text();
        }
        catch (e) {
            last = e;
            if (String(e).includes('HTTP 404'))
                break;
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
    }
    throw last instanceof Error ? last : new Error(String(last));
}
