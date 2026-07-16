import '@tanstack/react-start/server-only';
import { createHeadlessEditor } from '@lexical/headless';
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { Window } from 'happy-dom';
import { $createParagraphNode, $getRoot } from 'lexical';
import * as Y from 'yjs';

// ── Lexical namespace ─────────────────────────────────────────────────────────

export const LEXICAL_NAMESPACE = 'Vizzy Studio Text Bonanza';

// ── DOM globals shim for headless Lexical ─────────────────────────────────────
// Lexical requires browser globals. We inject a happy-dom Window before each
// call and restore the originals after, so server code stays unaffected.

const lexicalWindow = new Window();

export function withLexicalDomGlobals<T>(fn: () => T): T {
    const g = globalThis as any;
    const previous = {
        window: g.window,
        document: g.document,
        Document: g.Document,
        Node: g.Node,
        HTMLElement: g.HTMLElement
    };
    g.window = lexicalWindow;
    g.document = lexicalWindow.document;
    g.Document = lexicalWindow.Document;
    g.Node = lexicalWindow.Node;
    g.HTMLElement = lexicalWindow.HTMLElement;
    try {
        return fn();
    } finally {
        g.window = previous.window;
        g.document = previous.document;
        g.Document = previous.Document;
        g.Node = previous.Node;
        g.HTMLElement = previous.HTMLElement;
    }
}

// ── Noop provider ─────────────────────────────────────────────────────────────
// Lexical's YJS binding requires a collaboration provider. We supply a no-op
// one for server-side headless operations where no real provider is needed.

type NoopProvider = {
    awareness: {
        getLocalState: () => null;
        getStates: () => Map<number, unknown>;
        off: (_type: 'update', _cb: () => void) => void;
        on: (_type: 'update', _cb: () => void) => void;
        setLocalState: (_state: unknown) => void;
        setLocalStateField: (_field: string, _value: unknown) => void;
    };
    connect: () => void;
    disconnect: () => void;
    off: (
        _type: 'sync' | 'update' | 'status' | 'reload',
        _cb: (...args: unknown[]) => void
    ) => void;
    on: (_type: 'sync' | 'update' | 'status' | 'reload', _cb: (...args: unknown[]) => void) => void;
};

export function createNoopProvider(): NoopProvider {
    return {
        awareness: {
            getLocalState: () => null,
            getStates: () => new Map(),
            off: () => {},
            on: () => {},
            setLocalState: () => {},
            setLocalStateField: () => {}
        },
        connect: () => {},
        disconnect: () => {},
        off: () => {},
        on: () => {}
    };
}

// ── HTML ↔ YJS conversion ─────────────────────────────────────────────────────

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert an HTML string to a YJS binary state update. */
export async function htmlToYUpdate(html: string, docName: string): Promise<Uint8Array> {
    const doc = new Y.Doc();
    const docMap = new Map<string, Y.Doc>([[docName, doc]]);
    const provider = createNoopProvider();
    const editor = createHeadlessEditor({ namespace: LEXICAL_NAMESPACE, nodes: [] });
    const binding = createBinding(editor, provider as any, docName, doc, docMap);

    const unobserve = editor.registerUpdateListener(
        ({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
            syncLexicalUpdateToYjs(
                binding,
                provider as any,
                prevEditorState,
                editorState,
                dirtyElements,
                dirtyLeaves,
                normalizedNodes,
                tags
            );
        }
    );

    withLexicalDomGlobals(() => {
        const parser = new lexicalWindow.DOMParser();
        const dom = parser.parseFromString(html || '<p></p>', 'text/html');
        editor.update(() => {
            const root = $getRoot();
            root.clear();
            const nodes = $generateNodesFromDOM(editor, dom as unknown as Document);
            if (nodes.length === 0) {
                root.append($createParagraphNode());
            } else {
                root.append(...nodes);
            }
        });
    });

    await delay(0);
    unobserve();
    binding.root.destroy(binding as any);
    return Y.encodeStateAsUpdate(doc);
}

/** Render a YJS document back to an HTML string via Lexical. */
export async function yDocToHtml(doc: Y.Doc, docName: string): Promise<string> {
    const sourceUpdate = Y.encodeStateAsUpdate(doc);
    const tempDoc = new Y.Doc();
    const docMap = new Map<string, Y.Doc>([[docName, tempDoc]]);
    const provider = createNoopProvider();
    const editor = createHeadlessEditor({ namespace: LEXICAL_NAMESPACE, nodes: [] });
    const binding = createBinding(editor, provider as any, docName, tempDoc, docMap);

    const observer = (events: any[], transaction: Y.Transaction) => {
        syncYjsChangesToLexical(
            binding,
            provider as any,
            events as any,
            transaction.origin instanceof Y.UndoManager
        );
    };

    binding.root.getSharedType().observeDeep(observer);
    Y.applyUpdate(tempDoc, sourceUpdate);
    await delay(0);
    binding.root.getSharedType().unobserveDeep(observer);

    const html = withLexicalDomGlobals(() => {
        let out = '';
        editor.getEditorState().read(() => {
            out = $generateHtmlFromNodes(editor);
        });
        return out;
    });

    binding.root.destroy(binding as any);
    return html || '<p></p>';
}

/** Apply an HTML string directly to an existing YJS document. */
export async function applyHtmlToDoc(doc: Y.Doc, html: string, docName: string): Promise<void> {
    const update = await htmlToYUpdate(html, docName);
    Y.applyUpdate(doc, update);
}
