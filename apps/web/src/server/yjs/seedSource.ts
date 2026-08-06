/**
 * Which representation a fresh Yjs document should be seeded from.
 *
 * Kept separate from the session so the choice is unit-testable without pulling
 * in `@lexical/yjs`.
 */
export type SeedSource = 'state' | 'html';

export type SeedSourceInput = {
    hasTextState: boolean;
    /** Absent or 0 means the layer predates structured state. */
    textFormat: number | undefined;
    /** Highest format this build knows how to read. */
    supportedFormat: number;
};

/**
 * Prefer the serialized Lexical state: it round-trips losslessly, whereas the
 * HTML projection cannot represent everything Lexical can. A state stamped by a
 * newer deploy is deliberately ignored rather than guessed at — HTML is always
 * present and always readable, so degrading is safe.
 */
export function chooseSeedSource(input: SeedSourceInput): SeedSource {
    if (!input.hasTextState) return 'html';
    const format = input.textFormat ?? 0;
    if (format <= 0) return 'html';
    if (format > input.supportedFormat) return 'html';
    return 'state';
}
