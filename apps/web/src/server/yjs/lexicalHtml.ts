/**
 * HTML → Lexical node construction.
 *
 * Lexical's `$generateNodesFromDOM` discards inline `style` on text runs, so a
 * round trip through stored HTML silently loses colour, size and background.
 * The editor only produces paragraphs and styled/formatted text runs, so we
 * build that closed document model directly instead.
 *
 * Kept free of `@lexical/yjs` imports so it stays unit-testable.
 */
import {
    $createLineBreakNode,
    $createParagraphNode,
    $createTextNode,
    type ElementNode,
    type TextFormatType
} from 'lexical';

/** Style properties the toolbar can author. `white-space` is an export artifact. */
const PRESERVED_STYLE_PROPERTIES = new Set([
    'color',
    'background-color',
    'font-size',
    'font-family'
]);

const TAG_FORMATS: Record<string, TextFormatType> = {
    b: 'bold',
    strong: 'bold',
    i: 'italic',
    em: 'italic',
    u: 'underline',
    s: 'strikethrough',
    strike: 'strikethrough',
    del: 'strikethrough',
    code: 'code',
    sub: 'subscript',
    sup: 'superscript'
};

const BLOCK_TAGS = new Set([
    'p',
    'div',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'blockquote',
    'pre'
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export function parseStyleAttribute(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    const parsed: Record<string, string> = {};
    for (const declaration of raw.split(';')) {
        const separator = declaration.indexOf(':');
        if (separator === -1) continue;
        const property = declaration.slice(0, separator).trim().toLowerCase();
        const value = declaration.slice(separator + 1).trim();
        if (!property || !value) continue;
        if (!PRESERVED_STYLE_PROPERTIES.has(property)) continue;
        parsed[property] = value;
    }
    return parsed;
}

export function serializeStyle(style: Record<string, string>): string {
    return Object.entries(style)
        .map(([property, value]) => `${property}: ${value};`)
        .join(' ');
}

type MinimalNode = {
    nodeType: number;
    textContent: string | null;
    childNodes: ArrayLike<MinimalNode>;
    tagName?: string;
    getAttribute?: (name: string) => string | null;
};

/**
 * Append `container`'s children to `root` as Lexical nodes, preserving inline
 * style and tag-derived formats. Must run inside `editor.update()`.
 */
export function $appendHtmlToRoot(root: ElementNode, container: MinimalNode): void {
    const paragraphs: ElementNode[] = [];
    let current: ElementNode | null = null;

    const openParagraph = () => {
        const paragraph = $createParagraphNode();
        paragraphs.push(paragraph);
        current = paragraph;
        return paragraph;
    };

    const ensureParagraph = () => current ?? openParagraph();

    const visit = (
        node: MinimalNode,
        style: Record<string, string>,
        formats: ReadonlySet<TextFormatType>
    ) => {
        if (node.nodeType === TEXT_NODE) {
            const text = node.textContent ?? '';
            if (!text) return;
            const textNode = $createTextNode(text);
            const declaration = serializeStyle(style);
            if (declaration) textNode.setStyle(declaration);
            for (const format of formats) textNode.toggleFormat(format);
            ensureParagraph().append(textNode);
            return;
        }
        if (node.nodeType !== ELEMENT_NODE || !node.tagName) return;

        const tag = node.tagName.toLowerCase();
        if (tag === 'br') {
            ensureParagraph().append($createLineBreakNode());
            return;
        }

        const nextStyle = { ...style, ...parseStyleAttribute(node.getAttribute?.('style')) };
        const tagFormat = TAG_FORMATS[tag];
        // A Set collapses duplicates, so the `<b><strong>` nesting Lexical emits
        // on export applies bold once rather than toggling it back off.
        const nextFormats = tagFormat ? new Set([...formats, tagFormat]) : formats;
        const children = Array.from(node.childNodes);

        if (BLOCK_TAGS.has(tag)) {
            const hasBlockChild = children.some(
                (child) =>
                    child.nodeType === ELEMENT_NODE &&
                    child.tagName &&
                    BLOCK_TAGS.has(child.tagName.toLowerCase())
            );
            current = null;
            // Open eagerly so an empty block survives as an empty paragraph.
            if (!hasBlockChild) openParagraph();
            for (const child of children) visit(child, nextStyle, nextFormats);
            current = null;
            return;
        }

        for (const child of children) visit(child, nextStyle, nextFormats);
    };

    for (const child of Array.from(container.childNodes)) visit(child, {}, new Set());

    if (paragraphs.length === 0) paragraphs.push($createParagraphNode());
    root.append(...paragraphs);
}
