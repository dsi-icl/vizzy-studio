/**
 * The project's shared palette, as a plain row of squares. Deliberately
 * unlabelled beyond each swatch's accessible name, which is the convention for
 * recent-colour rows.
 */
export function RecentColourSwatches({
    recentColours,
    onPick
}: {
    recentColours: readonly string[];
    onPick: (colour: string) => void;
}) {
    if (recentColours.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-1 border-t border-border pt-2">
            {recentColours.map((colour) => (
                <button
                    key={colour}
                    type="button"
                    // Icon-only controls need an explicit name: without it the
                    // swatch is unreachable by assistive tech and by selectors.
                    aria-label={`Use colour ${colour}`}
                    title={colour}
                    onClick={() => onPick(colour)}
                    className="size-5 rounded-sm border border-border/60 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    style={{ backgroundColor: colour }}
                />
            ))}
        </div>
    );
}
