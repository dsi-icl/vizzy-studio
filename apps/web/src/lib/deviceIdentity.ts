'use client';

export type DeviceKind = 'wall' | 'gallery' | 'controller';

export interface DeviceIdentity {
    publicKey: string;
    signPayload: (payload: string) => Promise<string>;
}

const ALGO: EcKeyImportParams & EcdsaParams = {
    name: 'ECDSA',
    namedCurve: 'P-256',
    hash: 'SHA-256'
};

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function resolveDeviceSalt(): string {
    try {
        const url = new URL(window.location.href);
        const display = url.searchParams.get('d')?.trim() ?? '';
        const col = url.searchParams.get('c')?.trim() ?? '';
        const row = url.searchParams.get('r')?.trim() ?? '';
        const wallId = url.searchParams.get('w')?.trim() ?? '';
        const posComp = `c${col}r${row}_${wallId}`;
        if (!display) return `${posComp}_default`;
        const normalized = display.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return normalized.length > 0
            ? `${posComp}_${normalized.slice(0, 64)}`
            : `${posComp}_default`;
    } catch {
        return 'default';
    }
}

function storageKey(kind: DeviceKind) {
    return `vizzy_device_identity_${kind}_${resolveDeviceSalt()}`;
}

interface StoredIdentity {
    v: 1;
    pub: JsonWebKey;
    priv: JsonWebKey;
}

async function createIdentity(): Promise<StoredIdentity> {
    const pair = await crypto.subtle.generateKey(ALGO, true, ['sign', 'verify']);
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    return { v: 1, pub, priv };
}

async function loadOrCreateStoredIdentity(kind: DeviceKind): Promise<StoredIdentity> {
    const key = storageKey(kind);
    const raw = window.localStorage.getItem(key);
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as StoredIdentity;
            if (parsed.v === 1 && parsed.pub && parsed.priv) return parsed;
        } catch {
            // fall through to regeneration
        }
    }
    const created = await createIdentity();
    window.localStorage.setItem(key, JSON.stringify(created));
    return created;
}

const identityCache = new Map<DeviceKind, Promise<DeviceIdentity>>();

export function getOrCreateDeviceIdentity(kind: DeviceKind): Promise<DeviceIdentity> {
    const cached = identityCache.get(kind);
    if (cached) return cached;

    const pending = (async () => {
        const stored = await loadOrCreateStoredIdentity(kind);
        const privateKey = await crypto.subtle.importKey('jwk', stored.priv, ALGO, false, ['sign']);
        const publicKeyRaw = JSON.stringify(stored.pub);
        const signPayload = async (payload: string) => {
            const data = new TextEncoder().encode(payload);
            const sig = await crypto.subtle.sign(ALGO, privateKey, data);
            return toBase64Url(new Uint8Array(sig));
        };

        return {
            publicKey: publicKeyRaw,
            signPayload
        };
    })();

    identityCache.set(kind, pending);
    return pending;
}
