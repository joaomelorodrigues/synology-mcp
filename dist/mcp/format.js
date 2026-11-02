/** Output shaping. Tool replies are compact JSON: short keys' values in readable units, no empties. */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
export function bytes(value) {
    const number = Number(value);
    if (value === undefined || value === null || value === '' || !Number.isFinite(number))
        return undefined;
    let size = number;
    let unit = 0;
    while (size >= 1024 && unit < UNITS.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? size : size.toFixed(size >= 100 ? 0 : 1)} ${UNITS[unit]}`;
}
/** Percentage to one decimal, or undefined when the total is unknown. */
export function percent(part, whole) {
    const a = Number(part);
    const b = Number(whole);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0)
        return undefined;
    return Math.round((a / b) * 1000) / 10;
}
/** Epoch seconds (or milliseconds) to an ISO timestamp without milliseconds. */
export function isoTime(value) {
    const number = Number(value);
    if (value === undefined || value === null || value === '' || !Number.isFinite(number) || number <= 0)
        return undefined;
    const millis = number > 1e12 ? number : number * 1000;
    return new Date(millis).toISOString().replace('.000Z', 'Z');
}
export function duration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total < 0)
        return undefined;
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
}
/** Remove null, undefined and empty strings recursively. Keeps 0, false and empty arrays. */
export function compact(value) {
    if (Array.isArray(value))
        return value.map(compact);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === null || item === undefined || item === '')
                continue;
            out[key] = compact(item);
        }
        return out;
    }
    return value;
}
export function renderResult(value, maxChars) {
    const text = typeof value === 'string' ? value : JSON.stringify(compact(value));
    return clip(text ?? 'null', maxChars);
}
export function clip(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n...[output truncated: ${omitted} more characters. Narrow the request with offset/limit or a filter.]`;
}
export function renderError(error) {
    return JSON.stringify({ error: error.toJSON() });
}
/** Keys whose values should never reach a model or a log, whatever API they came from. */
const SECRET_KEY = /^(pass(word|wd|phrase)?|protect_password|secret|token|api_?key|private_?key|credentials?|sid|did|synotoken|otp(_code)?|smtp_pass|auth_key|chap_password|mutual_password)$/i;
export function redactSecrets(value) {
    if (Array.isArray(value))
        return value.map(redactSecrets);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = SECRET_KEY.test(key) && typeof item !== 'boolean' && item !== '' ? '[redacted]' : redactSecrets(item);
        }
        return out;
    }
    return value;
}
/** Accept what DSM sends where a list is expected: a list, an object of records, or nothing. */
export function asList(value) {
    if (Array.isArray(value))
        return value;
    if (value && typeof value === 'object')
        return Object.values(value);
    return [];
}
