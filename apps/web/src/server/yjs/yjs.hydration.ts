export type HydrationDecisionInput = {
    hasPersistedState: boolean;
    persistedRevision: number;
    commitRevision: number;
    persistedIsLegacy: boolean;
    persistedHtmlIsEmpty: boolean;
    commitHtmlIsEmpty: boolean;
    persistedSourceTextHash?: string;
    commitTextHash: string;
};

export function shouldRebuildYjsFromCommit(input: HydrationDecisionInput): boolean {
    if (!input.hasPersistedState) return true;
    if (input.commitRevision > input.persistedRevision) return true;
    return (
        !input.commitHtmlIsEmpty &&
        input.persistedHtmlIsEmpty &&
        (input.persistedIsLegacy || input.persistedSourceTextHash !== input.commitTextHash)
    );
}
