import { describe, expect, test } from 'bun:test';

import { createHeadlessEditor } from '@lexical/headless';
import { $generateHtmlFromNodes } from '@lexical/html';
import { Window } from 'happy-dom';
import { $createParagraphNode, $createTextNode, $getRoot, type TextFormatType } from 'lexical';

import { createTextExportMap, hoistDecorationStyles } from './lexicalExport';
import { $appendHtmlToRoot } from './lexicalHtml';

const LEXICAL_NAMESPACE = 'Vizzy Studio Text Bonanza';
const lexicalWindow = new Window();

function withLexicalDomGlobals<T>(fn: () => T): T {
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
        Object.assign(g, previous);
    }
}

function projectionEditor() {
    return createHeadlessEditor({
        namespace: LEXICAL_NAMESPACE,
        nodes: [],
        html: { export: createTextExportMap() }
    });
}

function exportRun(style: string, formats: readonly TextFormatType[]): string {
    const editor = projectionEditor();
    editor.update(
        () => {
            const paragraph = $createParagraphNode();
            const text = $createTextNode('Hxy');
            if (style) text.setStyle(style);
            for (const format of formats) text.toggleFormat(format);
            paragraph.append(text);
            $getRoot().append(paragraph);
        },
        { discrete: true }
    );
    return withLexicalDomGlobals(() => {
        let html = '';
        editor.getEditorState().read(() => {
            html = $generateHtmlFromNodes(editor);
        });
        return html;
    });
}

function el(html: string): HTMLElement {
    return withLexicalDomGlobals(() => {
        const doc = new lexicalWindow.DOMParser().parseFromString(html, 'text/html');
        return doc.body.firstElementChild as unknown as HTMLElement;
    });
}

describe('hoistDecorationStyles', () => {
    test('moves colour and size from the styled span to the wrapper', () => {
        const node = el('<u><span style="color: red; font-size: 2em">Hxy</span></u>');
        withLexicalDomGlobals(() => hoistDecorationStyles(node));

        expect(node.style.color).toBe('red');
        expect(node.style.fontSize).toBe('2em');
        // Moved, not copied — a nested `2em` would otherwise compound to 4em.
        const inner = node.children[0] as HTMLElement;
        expect(inner.style.color).toBe('');
        expect(inner.style.fontSize).toBe('');
    });

    test('hoists to the outermost wrapper so middle wrappers inherit', () => {
        const node = el('<u><s><span style="color: red; font-size: 2em">Hxy</span></s></u>');
        withLexicalDomGlobals(() => hoistDecorationStyles(node));

        expect(node.tagName.toLowerCase()).toBe('u');
        expect(node.style.color).toBe('red');
        expect(node.style.fontSize).toBe('2em');
    });

    test('leaves an unformatted run alone', () => {
        const node = el('<span style="color: red; font-size: 2em">Hxy</span>');
        withLexicalDomGlobals(() => hoistDecorationStyles(node));

        expect(node.style.color).toBe('red');
        expect(node.style.fontSize).toBe('2em');
    });

    test('preserves properties a decoration does not resolve against', () => {
        const node = el(
            '<u><span style="color: red; background-color: blue; white-space: pre-wrap">Hxy</span></u>'
        );
        withLexicalDomGlobals(() => hoistDecorationStyles(node));

        const inner = node.children[0] as HTMLElement;
        expect(inner.style.backgroundColor).toBe('blue');
        expect(inner.style.whiteSpace).toBe('pre-wrap');
        expect(node.style.backgroundColor).toBe('');
    });
});

describe('projected HTML', () => {
    test('underline carries the run colour (#144)', () => {
        const html = exportRun('color: #ef4444;', ['underline']);

        // The <u> declares the decoration, so it must be the element with the colour.
        expect(html).toMatch(/<u[^>]*style="[^"]*color: *#ef4444/);
        expect(html).toContain('<u');
    });

    test('strikethrough carries the run size (#72)', () => {
        const html = exportRun('font-size: 2em;', ['strikethrough']);

        expect(html).toMatch(/<s[^>]*style="[^"]*font-size: *2em/);
        // Not left on the inner span, where it would compound.
        expect(html).not.toMatch(/<span[^>]*font-size: *2em/);
    });

    test('both decorations at once resolve against the run', () => {
        const html = exportRun('color: #22c55e; font-size: 3em;', ['underline', 'strikethrough']);

        expect(html).toMatch(/<u[^>]*style="[^"]*color: *#22c55e/);
        expect(html).toMatch(/<u[^>]*style="[^"]*font-size: *3em/);
    });

    test('bold and italic still export as tags', () => {
        const html = exportRun('color: #3b82f6;', ['bold', 'italic']);

        expect(html).toContain('<b');
        expect(html).toContain('<i');
        expect(html).toMatch(/style="[^"]*color: *#3b82f6/);
    });

    test('the moved style survives the import path', () => {
        const exported = exportRun('color: #ef4444; font-size: 2em;', ['underline']);

        const editor = projectionEditor();
        withLexicalDomGlobals(() => {
            const dom = new lexicalWindow.DOMParser().parseFromString(exported, 'text/html');
            editor.update(
                () => {
                    const root = $getRoot();
                    root.clear();
                    $appendHtmlToRoot(root, dom.body as any);
                },
                { discrete: true }
            );
        });

        const reexported = withLexicalDomGlobals(() => {
            let html = '';
            editor.getEditorState().read(() => {
                html = $generateHtmlFromNodes(editor);
            });
            return html;
        });

        // Colour, size and the underline format all round trip.
        expect(reexported).toContain('<u');
        expect(reexported).toMatch(/color: *#ef4444/);
        expect(reexported).toMatch(/font-size: *2em/);
    });
});
