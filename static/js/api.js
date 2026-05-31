// api.js — centralized fetch helper
async function api(path, data) {
    const res = await fetch('/api/' + path, data ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    } : {});
    return res.json();
}
