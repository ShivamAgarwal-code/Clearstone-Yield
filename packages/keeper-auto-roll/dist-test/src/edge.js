/**
 * Backend-edge HTTP client. Minimal — just the endpoints the keeper
 * needs, typed narrowly.
 */
export async function fetchCuratorVaults(edgeUrl) {
    const res = await fetch(`${edgeUrl}/fixed-yield/curator-vaults`);
    if (!res.ok) {
        throw new Error(`edge GET /fixed-yield/curator-vaults → ${res.status}`);
    }
    const body = (await res.json());
    return body.vaults;
}
//# sourceMappingURL=edge.js.map