import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isForbiddenIp(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) {
        // Loopback: 127.0.0.0/8
        if (ip.startsWith('127.')) return true;
        // Current network: 0.0.0.0/8
        if (ip.startsWith('0.') || ip === '0.0.0.0') return true;
        // Private: 10.0.0.0/8
        if (ip.startsWith('10.')) return true;
        // Private: 192.168.0.0/16
        if (ip.startsWith('192.168.')) return true;
        // Private: 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
        if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
        // Link-local / Cloud metadata: 169.254.0.0/16
        if (ip.startsWith('169.254.')) return true;
        // Carrier-grade NAT: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
        if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(ip)) return true;
        // Benchmarking / TEST-NET: 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24
        if (ip.startsWith('192.0.0.') || ip.startsWith('192.0.2.') || ip.startsWith('198.51.100.')) {
            return true;
        }
        // Multicast / Reserved: 224.0.0.0/4, 240.0.0.0/4
        const firstOctet = parseInt(ip.split('.')[0] ?? '0', 10);
        if (firstOctet >= 224) return true;

        return false;
    }

    if (version === 6) {
        const normalized = ip.toLowerCase();
        // Loopback
        if (normalized === '::1') return true;
        // Unspecified
        if (normalized === '::') return true;
        // Unique local (fc00::/7)
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        // Link-local (fe80::/10)
        if (
            normalized.startsWith('fe8') ||
            normalized.startsWith('fe9') ||
            normalized.startsWith('fea') ||
            normalized.startsWith('feb')
        ) {
            return true;
        }
        // IPv4-mapped IPv6 (::ffff:x.x.x.x)
        if (normalized.startsWith('::ffff:')) {
            const mappedIpv4 = normalized.slice(7);
            if (isIP(mappedIpv4) === 4) {
                return isForbiddenIp(mappedIpv4);
            }
        }
        return false;
    }

    return true;
}

export async function assertSafeTargetUrl(rawUrl: string, allowlist: string[] = []): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs are allowed');
    }

    const host = parsed.hostname.toLowerCase();
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal')
    ) {
        throw new Error('Blocked host');
    }

    if (allowlist.length > 0 && !allowlist.includes(host)) {
        throw new Error('Host is not allowlisted');
    }

    if (isForbiddenIp(host)) {
        throw new Error('Blocked IP target');
    }

    // Resolve DNS and ensure no resolved address belongs to private/forbidden spaces
    const resolved = await lookup(host, { all: true });
    if (!resolved || resolved.length === 0) {
        throw new Error('DNS resolution failed');
    }

    if (resolved.some((entry) => isForbiddenIp(entry.address))) {
        throw new Error('Blocked resolved IP target');
    }

    return parsed;
}

export async function fetchWithSsrfProtection(
    rawUrl: string,
    init?: RequestInit,
    maxRedirects = 5
): Promise<Response> {
    let currentUrl = rawUrl;
    let redirectsCount = 0;

    while (redirectsCount <= maxRedirects) {
        await assertSafeTargetUrl(currentUrl);

        const response = await fetch(currentUrl, {
            ...init,
            redirect: 'manual'
        });

        const isRedirect =
            response.status === 301 ||
            response.status === 302 ||
            response.status === 303 ||
            response.status === 307 ||
            response.status === 308;

        if (!isRedirect) {
            return response;
        }

        const location = response.headers.get('location');
        if (!location) {
            return response;
        }

        const nextUrl = new URL(location, currentUrl).toString();
        await assertSafeTargetUrl(nextUrl);

        currentUrl = nextUrl;
        redirectsCount++;
    }

    throw new Error('Too many redirects');
}
