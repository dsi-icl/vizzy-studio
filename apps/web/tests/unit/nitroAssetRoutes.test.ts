import { describe, expect, test } from 'bun:test';

import { shouldNormalizeAssetFetchDestination } from '../../plugins/nitroAssetRoutes';

describe('Nitro development asset routing', () => {
    test.each(['image', 'video', 'font', 'audio'])(
        'normalizes the %s destination for the asset API',
        (destination) => {
            expect(
                shouldNormalizeAssetFetchDestination(
                    '/api/assets/example.webp?cache=1',
                    destination
                )
            ).toBe(true);
        }
    );

    test('normalizes a missing destination for asset URLs with file extensions', () => {
        expect(shouldNormalizeAssetFetchDestination('/api/assets/example.webp', undefined)).toBe(
            true
        );
    });

    test.each(['document', 'iframe', 'frame', 'empty'])(
        'leaves Nitro-compatible %s requests unchanged',
        (destination) => {
            expect(
                shouldNormalizeAssetFetchDestination('/api/assets/example.webp', destination)
            ).toBe(false);
        }
    );

    test('does not alter unrelated Vite asset requests', () => {
        expect(shouldNormalizeAssetFetchDestination('/src/logo.svg', 'image')).toBe(false);
        expect(shouldNormalizeAssetFetchDestination('/api/version', 'image')).toBe(false);
    });
});
