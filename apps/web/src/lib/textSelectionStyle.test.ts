import { describe, expect, test } from 'bun:test';

import { createHeadlessEditor } from '@lexical/headless';
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isRangeSelection,
    $isTextNode
} from 'lexical';

import { inheritTrailingTextStyle } from './textSelectionStyle';

function appendAtEnd(style: string): { before: string; after: string; textStyle: string } {
    const editor = createHeadlessEditor({ namespace: 'text-selection-style', nodes: [] });
    let result = { before: '', after: '', textStyle: '' };

    editor.update(
        () => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            const text = $createTextNode('Text');
            if (style) text.setStyle(style);
            paragraph.append(text);
            root.append(paragraph);
            root.selectEnd();

            const selection = $getSelection();
            if (!$isRangeSelection(selection)) throw new Error('No text selection');
            result.before = selection.style;
            inheritTrailingTextStyle(selection);
            result.after = selection.style;
            selection.insertText('!');
            const last = paragraph.getLastChild();
            if (!$isTextNode(last)) throw new Error('No text node');
            result.textStyle = last.getStyle();
        },
        { discrete: true }
    );

    return result;
}

describe('trailing text style', () => {
    test('new 200 px text stays 200 px when typing at the end', () => {
        expect(appendAtEnd('font-size: 200px;')).toEqual({
            before: '',
            after: 'font-size: 200px;',
            textStyle: 'font-size: 200px;'
        });
    });

    test('old unstyled text keeps its 48 px base', () => {
        expect(appendAtEnd('')).toEqual({ before: '', after: '', textStyle: '' });
    });
});
