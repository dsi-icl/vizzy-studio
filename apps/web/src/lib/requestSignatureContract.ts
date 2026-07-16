export const DEVICE_HEADER_KIND = 'x-vizzy-device-kind';
export const DEVICE_HEADER_PUBLIC_KEY = 'x-vizzy-device-public-key';
export const DEVICE_HEADER_SIGNATURE = 'x-vizzy-device-signature';
export const DEVICE_HEADER_TIMESTAMP = 'x-vizzy-device-timestamp';
export const DEVICE_HEADER_NONCE = 'x-vizzy-device-nonce';
export const DEVICE_HEADER_BODY_HASH = 'x-vizzy-device-body-sha256';
export const DEVICE_HEADER_WALL_ID = 'x-vizzy-device-wall-id';

export const DEVICE_BODY_HASH_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export function canonicalizeQuery(searchParams: URLSearchParams): string {
    const entries = Array.from(searchParams.entries()).sort(([ak, av], [bk, bv]) => {
        if (ak === bk) return av.localeCompare(bv);
        return ak.localeCompare(bk);
    });
    const out = new URLSearchParams();
    for (const [k, v] of entries) out.append(k, v);
    return out.toString();
}

export function buildCanonicalDeviceSignaturePayload(
    requestUrl: URL,
    method: string,
    timestamp: number,
    nonce: string,
    bodySha256: string | null
): string {
    const query = canonicalizeQuery(requestUrl.searchParams);
    return `${method.toUpperCase()}\n${requestUrl.pathname}\n${query}\n${timestamp}\n${nonce}\n${bodySha256 ?? ''}`;
}
