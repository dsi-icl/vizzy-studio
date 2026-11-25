import http from 'node:http';
import { Readable } from 'node:stream';

/** Bun 1.4+ runs node:http on net sockets, separate from screen fetch traffic. */
export function fetchServeControlDocument(
    upstreamUrl: string,
    forwardedHeaders: Headers,
    signal: AbortSignal
): Promise<Response> {
    const url = new URL(upstreamUrl);
    if (url.protocol !== 'http:') throw new Error('Serve demo origin must use HTTP');

    return new Promise((resolve, reject) => {
        const request = http.request(
            url,
            {
                method: 'GET',
                headers: Object.fromEntries(forwardedHeaders.entries()),
                agent: false
            },
            (upstream) => {
                const headers = new Headers();
                for (let index = 0; index < upstream.rawHeaders.length; index += 2) {
                    headers.append(upstream.rawHeaders[index]!, upstream.rawHeaders[index + 1]!);
                }
                const status = upstream.statusCode ?? 502;
                const body = [204, 205, 304].includes(status)
                    ? null
                    : (Readable.toWeb(upstream) as unknown as ReadableStream<Uint8Array>);
                resolve(new Response(body, { status, headers }));
            }
        );
        const abortRequest = () => {
            const error =
                signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException('Control request aborted', 'AbortError');
            reject(error);
            request.destroy(error);
        };
        signal.addEventListener('abort', abortRequest, { once: true });
        request.once('close', () => signal.removeEventListener('abort', abortRequest));
        request.once('error', reject);
        if (signal.aborted) {
            abortRequest();
            return;
        }
        request.end();
    });
}
