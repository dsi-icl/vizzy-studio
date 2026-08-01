import type { Provider } from '@lexical/yjs';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import { getWebSocketUrl } from '../../lib/runtimeUrl';

export type LexicalWebsocketProvider = WebsocketProvider & Provider;

export function createWebsocketProvider(
    id: string,
    yjsDocMap: Map<string, Y.Doc>
): LexicalWebsocketProvider {
    const doc = getDocFromMap(id, yjsDocMap);

    return new WebsocketProvider(getWebSocketUrl('/yjs'), id, doc, {
        connect: false
    }) as unknown as LexicalWebsocketProvider;
}

function getDocFromMap(id: string, yjsDocMap: Map<string, Y.Doc>): Y.Doc {
    let doc = yjsDocMap.get(id);

    if (doc === undefined) {
        doc = new Y.Doc();
        yjsDocMap.set(id, doc);
    } else {
        doc.load();
    }

    return doc;
}
