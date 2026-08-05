import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('~/server/collections', () => ({ dbCol: {} }));

const { createAssetNotFoundResponse } = await import('./$uri');

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
    if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
    } else {
        process.env.NODE_ENV = originalNodeEnv;
    }
});

describe('asset not-found responses', () => {
    test('includes the status message and exact reason code in development', () => {
        process.env.NODE_ENV = 'development';

        const response = createAssetNotFoundResponse({
            reasonCode: 'ASSET_FILE_NOT_FOUND',
            statusMessage: 'Asset File Not Found'
        });

        expect(response.status).toBe(404);
        expect(response.headers.get('X-Dev-Status-Message')).toBe('Asset File Not Found');
        expect(response.headers.get('X-Dev-Reason-Code')).toBe('ASSET_FILE_NOT_FOUND');
    });

    test('uses the reason code when no status message is supplied', () => {
        process.env.NODE_ENV = 'development';

        const response = createAssetNotFoundResponse({
            reasonCode: 'INVALID_ASSET_URI'
        });

        expect(response.headers.get('X-Dev-Status-Message')).toBe('INVALID_ASSET_URI');
        expect(response.headers.get('X-Dev-Reason-Code')).toBe('INVALID_ASSET_URI');
    });

    test('does not expose diagnostics outside development', () => {
        process.env.NODE_ENV = 'production';

        const response = createAssetNotFoundResponse({
            reasonCode: 'ASSET_FILE_NOT_FOUND',
            statusMessage: 'Asset File Not Found'
        });

        expect(response.status).toBe(404);
        expect(response.headers.get('X-Dev-Status-Message')).toBeNull();
        expect(response.headers.get('X-Dev-Reason-Code')).toBeNull();
    });
});
