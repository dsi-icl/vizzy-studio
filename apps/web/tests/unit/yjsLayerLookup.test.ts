import { describe, expect, test } from 'bun:test';

import { retryTextLayerLookup, TextLayerLookupError } from '../../src/server/yjs/yjs.layerLookup';

describe('Yjs text-layer lookup tolerance', () => {
    test('waits for a newly-created layer to become visible', async () => {
        let attempts = 0;
        const retries: number[] = [];
        const result = await retryTextLayerLookup(
            async () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new TextLayerLookupError(
                        'Text layer 12 not found in slide slide-a',
                        'layer_missing'
                    );
                }
                return 'hydrated';
            },
            {
                delaysMs: [5, 10],
                sleep: async () => undefined,
                beforeRetry: (_error, attempt) => {
                    retries.push(attempt);
                }
            }
        );

        expect(result).toBe('hydrated');
        expect(attempts).toBe(3);
        expect(retries).toEqual([1, 2]);
    });

    test('fails immediately for a numeric-ID collision with a non-text layer', async () => {
        let attempts = 0;
        const error = new TextLayerLookupError(
            'Layer 12 in slide slide-a is not a text layer',
            'layer_not_text'
        );

        expect(
            retryTextLayerLookup(
                async () => {
                    attempts += 1;
                    throw error;
                },
                { delaysMs: [0, 0], sleep: async () => undefined }
            )
        ).rejects.toBe(error);
        expect(attempts).toBe(1);
    });

    test('preserves the existing missing-layer error after bounded retries', async () => {
        let attempts = 0;
        const lookup = retryTextLayerLookup(
            async () => {
                attempts += 1;
                throw new TextLayerLookupError(
                    'Text layer 87 not found in slide slide-z',
                    'layer_missing'
                );
            },
            { delaysMs: [0, 0], sleep: async () => undefined }
        );

        expect(lookup).rejects.toThrow('Text layer 87 not found in slide slide-z');
        expect(attempts).toBe(3);
    });
});
