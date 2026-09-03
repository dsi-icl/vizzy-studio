export interface LayerCenter {
    cx: number;
    cy: number;
}

/**
 * Compute the translated centre of every layer in a group drag. Each layer moves by
 * the same delta (oldPos - newPos) as the anchor, if no anchor the result is empty.
 */
export const computeGroupTranslation = (
    startPositions: Map<number, LayerCenter>,
    anchorId: number,
    anchorNewPos: { x: number; y: number }
): Map<number, LayerCenter> => {
    const result = new Map<number, LayerCenter>();
    const anchorStart = startPositions.get(anchorId);
    if (!anchorStart) return result;

    const dx = anchorNewPos.x - anchorStart.cx;
    const dy = anchorNewPos.y - anchorStart.cy;
    for (const [id, start] of startPositions) {
        result.set(id, { cx: start.cx + dx, cy: start.cy + dy });
    }
    return result;
};
