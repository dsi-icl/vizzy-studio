import { describe, expect, test } from 'bun:test';

import { assertSafeTargetUrl, isForbiddenIp } from '../../src/lib/networkSecurity';

/** Resolve to the rejection message, or fail if the URL was accepted. */
async function rejectionMessage(url: string, allowlist?: string[]): Promise<string> {
    try {
        await assertSafeTargetUrl(url, allowlist);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`Expected ${url} to be rejected, but it was accepted`);
}

describe('isForbiddenIp', () => {
    test.each([
        '127.0.0.1',
        '10.0.0.1',
        '192.168.1.1',
        '172.16.0.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '::1',
        '::',
        'fd00::1',
        'fe80::1'
    ])('rejects the reserved address %s', (ip) => {
        expect(isForbiddenIp(ip)).toBe(true);
    });

    // URL parsing serializes IPv4-mapped IPv6 to hex, so both spellings must be caught.
    test.each(['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1'])(
        'rejects the IPv4-mapped address %s',
        (ip) => {
            expect(isForbiddenIp(ip)).toBe(true);
        }
    );

    test.each(['1.1.1.1', '93.184.216.34', '128.128.128.128', '::ffff:8080:8080'])(
        'allows the public address %s',
        (ip) => {
            expect(isForbiddenIp(ip)).toBe(false);
        }
    );
});

describe('assertSafeTargetUrl', () => {
    // Regression guard: hostnames are vetted by DNS resolution, not by the literal IP
    // check. Treating a hostname as a forbidden IP blocks every ordinary target.
    test.each(['https://example.com/', 'https://example.com/nested/path?query=1'])(
        'resolves the public hostname %s',
        async (url) => {
            expect(await assertSafeTargetUrl(url)).toBeInstanceOf(URL);
        }
    );

    test('resolves a public IP literal without a DNS lookup', async () => {
        expect(await assertSafeTargetUrl('http://1.1.1.1/')).toBeInstanceOf(URL);
    });

    test.each([
        'http://127.0.0.1/',
        'http://10.0.0.5/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://[fd00::1]/',
        // Decimal and hexadecimal spellings normalize to 127.0.0.1 during URL parsing.
        'http://2130706433/',
        'http://0x7f.0.0.1/'
    ])('rejects the reserved target %s', async (url) => {
        expect(await rejectionMessage(url)).toBe('Blocked IP target');
    });

    test.each([
        'http://localhost/',
        'http://foo.localhost/',
        'http://db.internal/',
        'http://x.local/'
    ])('rejects the internal hostname %s', async (url) => {
        expect(await rejectionMessage(url)).toBe('Blocked host');
    });

    test('rejects a non-http scheme', async () => {
        expect(await rejectionMessage('ftp://example.com/')).toBe(
            'Only http/https URLs are allowed'
        );
    });

    test('rejects a forbidden port', async () => {
        expect(await rejectionMessage('https://example.com:27017/')).toBe('Blocked port target');
    });

    test('rejects a host outside a supplied allowlist', async () => {
        expect(await rejectionMessage('https://example.com/', ['allowed.test'])).toBe(
            'Host is not allowlisted'
        );
    });
});
