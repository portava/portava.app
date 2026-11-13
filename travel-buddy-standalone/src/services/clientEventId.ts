/** Retry identity only; never an authorization secret. Pure on native/web/tests. */
export function newClientEventId(): string {
    const c = (globalThis as {
        crypto?: {
            randomUUID?: () => string;
        };
    }).crypto;
    if (c && typeof c.randomUUID === 'function')
        return c.randomUUID();
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}
