import { TextNode, type DOMExportOutput, type LexicalEditor, type LexicalNode } from 'lexical';

const DECORATION_STYLE_PROPERTIES = ['color', 'font-size', 'font-family'] as const;

export function hoistDecorationStyles(element: HTMLElement): void {
    let inner = element;
    while (inner.children.length === 1) inner = inner.children[0] as HTMLElement;
    if (inner === element) return;

    for (const property of DECORATION_STYLE_PROPERTIES) {
        const value = inner.style.getPropertyValue(property);
        if (!value) continue;
        element.style.setProperty(property, value);
        inner.style.removeProperty(property);
    }
}

export function createTextExportMap() {
    return new Map([
        [
            TextNode,
            (editor: LexicalEditor, node: LexicalNode): DOMExportOutput => {
                const output = (node as TextNode).exportDOM(editor);
                const element = output.element;
                if (element && element instanceof (globalThis as any).HTMLElement) {
                    hoistDecorationStyles(element as HTMLElement);
                }
                return output;
            }
        ]
    ]);
}
