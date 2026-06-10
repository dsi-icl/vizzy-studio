export const LINE_SEGMENTS_UPDATE_OPCODE = 0x16;
const LINE_SEGMENTS_UPDATE_VERSION = 1;

type LineSegmentsUpdate = {
    numericId: number;
    line: number[];
    segments: number[][];
};

export function encodeLineSegmentsUpdate({
    numericId,
    line,
    segments
}: LineSegmentsUpdate): ArrayBuffer {
    const headerBytes = 1 + 2 + 4 + 4;
    const lineBytes = line.length * 4;
    const segmentHeaderBytes = 4;
    const segmentsBytes = segments.reduce((total, segment) => total + 4 + segment.length * 4, 0);

    const buffer = new ArrayBuffer(headerBytes + lineBytes + segmentHeaderBytes + segmentsBytes);
    const view = new DataView(buffer);

    let offset = 0;

    view.setUint8(offset, LINE_SEGMENTS_UPDATE_OPCODE);
    offset += 1;

    view.setUint16(offset, LINE_SEGMENTS_UPDATE_VERSION, true);
    offset += 2;

    view.setUint32(offset, numericId, true);
    offset += 4;

    view.setUint32(offset, line.length, true);
    offset += 4;

    for (const value of line) {
        view.setInt32(offset, Math.round(value), true);
        offset += 4;
    }

    view.setUint32(offset, segments.length, true);
    offset += 4;

    for (const segment of segments) {
        view.setUint32(offset, segment.length, true);
        offset += 4;

        for (const value of segment) {
            view.setInt32(offset, Math.round(value), true);
            offset += 4;
        }
    }

    return buffer;
}

export function decodeLineSegmentsUpdate(buffer: ArrayBuffer): LineSegmentsUpdate | null {
    const view = new DataView(buffer);
    let offset = 0;

    const opcode = view.getUint8(offset);
    offset += 1;

    if (opcode !== LINE_SEGMENTS_UPDATE_OPCODE) return null;

    const version = view.getUint16(offset, true);
    offset += 2;

    if (version !== LINE_SEGMENTS_UPDATE_VERSION) return null;

    const numericId = view.getUint32(offset, true);
    offset += 4;

    const lineLength = view.getUint32(offset, true);
    offset += 4;

    const line: number[] = [];
    for (let i = 0; i < lineLength; i += 1) {
        line.push(view.getInt32(offset, true));
        offset += 4;
    }

    const segmentCount = view.getUint32(offset, true);
    offset += 4;

    const segments: number[][] = [];
    for (let i = 0; i < segmentCount; i += 1) {
        const segmentLength = view.getUint32(offset, true);
        offset += 4;

        const segment: number[] = [];
        for (let j = 0; j < segmentLength; j += 1) {
            segment.push(view.getInt32(offset, true));
            offset += 4;
        }

        segments.push(segment);
    }

    return { numericId, line, segments };
}
