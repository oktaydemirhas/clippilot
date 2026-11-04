/** Job ids are random UUIDs. Anything else in the data directory or in a URL is not ours. */
export const ID_RE = /^[0-9a-f-]{36}$/;
