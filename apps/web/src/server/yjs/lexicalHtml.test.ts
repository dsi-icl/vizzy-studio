import { describe, expect, test } from 'bun:test';

import { createHeadlessEditor } from '@lexical/headless';
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import { Window } from 'happy-dom';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';

import { $appendHtmlToRoot, parseStyleAttribute, serializeStyle } from './lexicalHtml';

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

function newEditor() {
    return createHeadlessEditor({ namespace: LEXICAL_NAMESPACE, nodes: [] });
}

function toHtml(editor: ReturnType<typeof newEditor>): string {
    return withLexicalDomGlobals(() => {
        let html = '';
        editor.getEditorState().read(() => {
            html = $generateHtmlFromNodes(editor);
        });
        return html;
    });
}

/** Import HTML the way the server rebuild path does, then export it again. */
function importExport(html: string): string {
    const editor = newEditor();
    withLexicalDomGlobals(() => {
        const parser = new lexicalWindow.DOMParser();
        const dom = parser.parseFromString(html || '<p></p>', 'text/html');
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                $appendHtmlToRoot(root, dom.body as any);
            },
            { discrete: true }
        );
    });
    return toHtml(editor);
}

/** The previous implementation, kept as a control so the defect stays documented. */
function legacyImportExport(html: string): string {
    const editor = newEditor();
    withLexicalDomGlobals(() => {
        const parser = new lexicalWindow.DOMParser();
        const dom = parser.parseFromString(html || '<p></p>', 'text/html');
        editor.update(
            () => {
                const root = $getRoot();
                root.clear();
                const nodes = $generateNodesFromDOM(editor, dom as unknown as Document);
                if (nodes.length === 0) root.append($createParagraphNode());
                else root.append(...nodes);
            },
            { discrete: true }
        );
    });
    return toHtml(editor);
}

/** Author content the way the browser toolbar does, via node styles. */
function authored(runs: { text: string; style?: string; formats?: string[] }[]): string {
    const editor = newEditor();
    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            for (const run of runs) {
                const node = $createTextNode(run.text);
                if (run.style) node.setStyle(run.style);
                for (const format of run.formats ?? []) node.toggleFormat(format as any);
                paragraph.append(node);
            }
            root.append(paragraph);
        },
        { discrete: true }
    );
    return toHtml(editor);
}

describe('style attribute parsing', () => {
    test('keeps authored properties and drops export artifacts', () => {
        expect(
            parseStyleAttribute('color: #ef4444; font-size: 2em; white-space: pre-wrap;')
        ).toEqual({ color: '#ef4444', 'font-size': '2em' });
    });

    test('tolerates empty and malformed declarations', () => {
        expect(parseStyleAttribute(null)).toEqual({});
        expect(parseStyleAttribute('')).toEqual({});
        expect(parseStyleAttribute('nonsense')).toEqual({});
        expect(parseStyleAttribute('color:')).toEqual({});
    });

    test('serializes back to a declaration string', () => {
        expect(serializeStyle({ color: '#fff', 'font-size': '1.5em' })).toBe(
            'color: #fff; font-size: 1.5em;'
        );
    });
});

describe('HTML import preserves text styling', () => {
    test('colour survives a round trip', () => {
        const html = authored([{ text: 'Red', style: 'color: #ef4444;' }]);
        expect(importExport(html)).toContain('#ef4444');
    });

    test('font size survives a round trip', () => {
        const html = authored([{ text: 'Big', style: 'font-size: 2em;' }]);
        expect(importExport(html)).toContain('2em');
    });

    test('background colour survives a round trip', () => {
        const html = authored([{ text: 'Hl', style: 'background-color: #fde047;' }]);
        expect(importExport(html)).toContain('#fde047');
    });

    test('colour and size together survive a round trip', () => {
        const html = authored([{ text: 'Both', style: 'color: #22c55e; font-size: 3.5em;' }]);
        const out = importExport(html);
        expect(out).toContain('#22c55e');
        expect(out).toContain('3.5em');
    });

    test('mixed styled runs each keep their own styling', () => {
        const html = authored([
            { text: 'Red big', style: 'color: #ef4444; font-size: 2em;' },
            { text: ' green bold', style: 'color: #22c55e;', formats: ['bold'] }
        ]);
        const out = importExport(html);
        expect(out).toContain('#ef4444');
        expect(out).toContain('2em');
        expect(out).toContain('#22c55e');
        expect(out).toContain('Red big');
        expect(out).toContain(' green bold');
    });
});

describe('HTML import preserves text formats', () => {
    test('bold survives the nested b/strong that export emits', () => {
        const html = authored([{ text: 'Bold', formats: ['bold'] }]);
        expect(html).toContain('<strong');
        const out = importExport(html);
        expect(out).toContain('<strong');
        expect(out).toContain('Bold');
    });

    test('italic, underline and strikethrough survive', () => {
        for (const format of ['italic', 'underline', 'strikethrough']) {
            const html = authored([{ text: format, formats: [format] }]);
            const out = importExport(html);
            expect(out).toContain(format);
            expect(out).not.toBe('<p><br></p>');
        }
    });

    test('a format combined with a style keeps both', () => {
        const html = authored([
            { text: 'Both', style: 'color: #3b82f6; font-size: 1.25em;', formats: ['bold'] }
        ]);
        const out = importExport(html);
        expect(out).toContain('#3b82f6');
        expect(out).toContain('1.25em');
        expect(out).toContain('<strong');
    });
});

describe('HTML import structural handling', () => {
    test('is idempotent across repeated cycles', () => {
        const html = authored([{ text: 'Stable', style: 'color: #3b82f6; font-size: 1.5em;' }]);
        const once = importExport(html);
        const twice = importExport(once);
        expect(twice).toBe(once);
    });

    test('empty input yields a single empty paragraph', () => {
        expect(importExport('')).toBe('<p><br></p>');
    });

    test('preserves multiple paragraphs', () => {
        const out = importExport('<p>One</p><p>Two</p>');
        expect(out).toContain('One');
        expect(out).toContain('Two');
        expect(out.match(/<p/g)?.length).toBe(2);
    });

    test('preserves line breaks', () => {
        const out = importExport('<p>A<br>B</p>');
        expect(out).toContain('<br>');
        expect(out).toContain('A');
        expect(out).toContain('B');
    });

    test('recovers text from unsupported block elements', () => {
        const out = importExport('<h1>Title</h1><ul><li>Item</li></ul>');
        expect(out).toContain('Title');
        expect(out).toContain('Item');
    });

    test('plain text with no markup is retained', () => {
        expect(importExport('bare')).toContain('bare');
    });
});

describe('regression control: the previous importer lost styling', () => {
    test('$generateNodesFromDOM drops colour and size where the new importer keeps them', () => {
        const html = authored([{ text: 'Red big', style: 'color: #ef4444; font-size: 2em;' }]);

        expect(html).toContain('#ef4444');
        expect(legacyImportExport(html)).not.toContain('#ef4444');
        expect(legacyImportExport(html)).not.toContain('2em');

        expect(importExport(html)).toContain('#ef4444');
        expect(importExport(html)).toContain('2em');
    });
});
