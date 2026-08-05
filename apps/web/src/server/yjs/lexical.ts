import '@tanstack/react-start/server-only';
import { createHeadlessEditor } from '@lexical/headless';
import { $generateHtmlFromNodes } from '@lexical/html';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { Window } from 'happy-dom';
import { $getRoot } from 'lexical';
import * as Y from 'yjs';

import { $appendHtmlToRoot } from './lexicalHtml';

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

/** Build a YJS state update from whatever `apply` writes into a fresh editor. */
async function editorToYUpdate(
    docName: string,
    apply: (editor: ReturnType<typeof createHeadlessEditor>) => void
): Promise<Uint8Array> {
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

    try {
        apply(editor);
        await delay(0);
    } finally {
        unobserve();
        binding.root.destroy(binding as any);
    }
    return Y.encodeStateAsUpdate(doc);
}

/** Convert an HTML string to a YJS binary state update. */
export async function htmlToYUpdate(html: string, docName: string): Promise<Uint8Array> {
    return editorToYUpdate(docName, (editor) => {
        withLexicalDomGlobals(() => {
            const parser = new lexicalWindow.DOMParser();
            const dom = parser.parseFromString(html || '<p></p>', 'text/html');
            editor.update(() => {
                const root = $getRoot();
                root.clear();
                $appendHtmlToRoot(root, dom.body as never);
            });
        });
    });
}

/**
 * Convert a serialized Lexical editor state to a YJS binary state update.
 * Throws if the payload is malformed or references unknown nodes — callers are
 * expected to fall back to the HTML projection.
 */
export async function lexicalStateToYUpdate(state: string, docName: string): Promise<Uint8Array> {
    return editorToYUpdate(docName, (editor) => {
        editor.setEditorState(editor.parseEditorState(state));
    });
}

export type TextProjection = {
    /** Derived render artifact. */
    html: string;
    /** Serialized Lexical editor state — lossless, unlike the HTML. */
    state: string;
};

/**
 * Project a YJS document to both representations in a single pass, so the HTML
 * and the serialized state can never describe different content.
 */
export async function yDocToProjection(doc: Y.Doc, docName: string): Promise<TextProjection> {
    return yDocToLexical(doc, docName, (editor) => {
        const html = withLexicalDomGlobals(() => {
            let out = '';
            editor.getEditorState().read(() => {
                out = $generateHtmlFromNodes(editor);
            });
            return out;
        });
        return { html: html || '<p></p>', state: JSON.stringify(editor.getEditorState().toJSON()) };
    });
}

/** Hydrate a throwaway Lexical editor from a YJS document and read from it. */
async function yDocToLexical<Result>(
    doc: Y.Doc,
    docName: string,
    read: (editor: ReturnType<typeof createHeadlessEditor>) => Result
): Promise<Result> {
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

    try {
        return read(editor);
    } finally {
        binding.root.destroy(binding as any);
    }
}

/** Render a YJS document back to an HTML string via Lexical. */
export async function yDocToHtml(doc: Y.Doc, docName: string): Promise<string> {
    const projection = await yDocToProjection(doc, docName);
    return projection.html;
}

/** Apply an HTML string directly to an existing YJS document. */
export async function applyHtmlToDoc(doc: Y.Doc, html: string, docName: string): Promise<void> {
    const update = await htmlToYUpdate(html, docName);
    Y.applyUpdate(doc, update);
}

/** Apply a serialized Lexical editor state directly to an existing YJS document. */
export async function applyLexicalStateToDoc(
    doc: Y.Doc,
    state: string,
    docName: string
): Promise<void> {
    const update = await lexicalStateToYUpdate(state, docName);
    Y.applyUpdate(doc, update);
}
