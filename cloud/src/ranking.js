/**
 * ranking.js — leaderboard order (design doc §8.1). Pure functions, shared by the class
 * board and the CSV export.
 *
 *   1. Most points        (higher first)
 *   2. Fastest            (lower elapsedMs first)
 *   3. Most energy left   (higher first)
 *   4. Has meds           (true first)
 *   5. Has toy            (true first)
 *
 * Results still tied after rule 5 share a rank (1, 1, 3 …).
 */

/** Negative when `a` ranks above `b`, 0 when tied on every rule. */
export function compareResults(a, b) {
    return (
        b.points - a.points ||
        a.elapsedMs - b.elapsedMs ||
        b.energy - a.energy ||
        Number(!!b.hasMeds) - Number(!!a.hasMeds) ||
        Number(!!b.hasToy) - Number(!!a.hasToy)
    );
}

/** Sorted copy with `rank` filled in (ties share a rank). */
export function rankResults(results) {
    const sorted = [...results].sort(
        (a, b) => compareResults(a, b) || String(a.pair).localeCompare(String(b.pair)) || a.attempt - b.attempt
    );
    let rank = 0;
    return sorted.map((r, i) => {
        if (i === 0 || compareResults(sorted[i - 1], r) !== 0) rank = i + 1;
        return { ...r, rank };
    });
}

/** Each pair's best attempt (by the same rules). */
export function bestPerPair(results) {
    const best = new Map();
    for (const r of results) {
        const cur = best.get(r.pair);
        if (!cur || compareResults(r, cur) < 0) best.set(r.pair, r);
    }
    return [...best.values()];
}

/** "m:ss" for a millisecond duration. */
export function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
}
