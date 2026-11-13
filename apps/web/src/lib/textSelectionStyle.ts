import { $isTextNode, type RangeSelection } from 'lexical';

/** Keep the last text run's style when a caret lands at the end of its paragraph. */
export function inheritTrailingTextStyle(selection: RangeSelection): void {
    if (!selection.isCollapsed() || selection.style) return;

    const node = selection.anchor.getNode();
    if (
        !$isTextNode(node) ||
        selection.anchor.offset !== node.getTextContentSize() ||
        node.getNextSibling()
    ) {
        return;
    }

    const style = node.getStyle();
    if (style) selection.setStyle(style);
}
