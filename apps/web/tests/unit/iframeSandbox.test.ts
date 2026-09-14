import { describe, expect, test } from 'bun:test';

import { resolveIframeSandbox } from '../../src/lib/iframeSandbox';

const APP_ORIGIN = 'https://vizzy.example.ac.uk';

const sandboxFor = (src: string) => resolveIframeSandbox(src, APP_ORIGIN);

describe('resolveIframeSandbox', () => {
    // Proxied content is a third party served from our own origin, so it must
    // stay in an opaque origin or it can reach parent.document and unsandbox itself.
    test.each([
        '/api/proxy?url=https%3A%2F%2Fdemos.example.ac.uk%2Fscreen',
        'https://vizzy.example.ac.uk/api/proxy?url=https%3A%2F%2Fdemos.example.ac.uk%2Fscreen'
    ])('keeps proxied content opaque: %s', (src) => {
        expect(sandboxFor(src)).toBe('allow-scripts allow-forms');
    });

    test.each(['/web-nonet?l=wall', '/web-corsissue?l=wall', '/web-placeholder?l=wall'])(
        'lets our own fallback page hydrate: %s',
        (src) => {
            expect(sandboxFor(src)).toBe('allow-scripts allow-same-origin');
        }
    );

    test.each([
        'https://demos.example.ac.uk/ideafast/screen?c=0&r=0',
        'http://demos.example.ac.uk/sentinel/screen',
        'https://vizzy.example.ac.uk.evil.test/screen'
    ])('gives a remote document its own origin: %s', (src) => {
        expect(sandboxFor(src)).toBe('allow-scripts allow-same-origin allow-forms');
    });

    // A custom render URL pointing back at this app would otherwise be handed
    // allow-same-origin on our origin, which is the escape we are preventing.
    test.each([
        'https://vizzy.example.ac.uk/gallery',
        'https://vizzy.example.ac.uk/admin/users',
        '/gallery'
    ])('never grants same-origin to an unrecognised local route: %s', (src) => {
        expect(sandboxFor(src)).toBe('allow-scripts allow-forms');
    });

    test('treats a same-origin URL on a different port as remote', () => {
        expect(sandboxFor('https://vizzy.example.ac.uk:8443/web-nonet')).toBe(
            'allow-scripts allow-same-origin allow-forms'
        );
    });

    test.each(['//demos.example.ac.uk/screen', 'not a url', ''])(
        'never trusts an ambiguous source: %s',
        (src) => {
            expect(sandboxFor(src)).not.toBe('allow-scripts allow-same-origin');
        }
    );

    test('treats absolute sources as remote when the origin is unknown', () => {
        expect(resolveIframeSandbox('https://demos.example.ac.uk/screen', '')).toBe(
            'allow-scripts allow-same-origin allow-forms'
        );
    });

    test('still recognises relative fallbacks when the origin is unknown', () => {
        expect(resolveIframeSandbox('/web-nonet?l=wall', '')).toBe(
            'allow-scripts allow-same-origin'
        );
    });

    test('never omits allow-scripts', () => {
        for (const src of ['/api/proxy?url=x', '/web-nonet', 'https://demos.example.ac.uk/']) {
            expect(sandboxFor(src)).toContain('allow-scripts');
        }
    });

    test('never grants top navigation or popups', () => {
        for (const src of ['/api/proxy?url=x', '/web-nonet', 'https://demos.example.ac.uk/']) {
            expect(sandboxFor(src)).not.toContain('allow-top-navigation');
            expect(sandboxFor(src)).not.toContain('allow-popups');
        }
    });
});
