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
