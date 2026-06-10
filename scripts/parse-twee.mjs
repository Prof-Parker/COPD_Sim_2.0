/**
 * Parse COPD simulation .twee source into passage models with navigation edges.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SYSTEM_PASSAGES = new Set([
    "StoryTitle",
    "StoryData",
    "StoryInit",
    "StoryScript",
    "StoryStylesheet",
    "StoryCaption",
    "PassageHeader",
    "PassageFooter",
    "PassageReady",
    "Widgets",
]);

const TERMINAL_PASSAGES = new Set([
    "Final_Report",
    "Game_Over_Energy",
    "Game_Over_Inhaler",
]);

const PASSAGE_HEADER = /^::\s+([^\n{]+?)(?:\s+\[([^\]]*)\])?(?:\s+\{[^}]*\})?\s*$/;

/**
 * @param {string} tweePath
 * @returns {{ passages: Map<string, object>, passageNames: Set<string> }}
 */
export function parseTweeFile(tweePath) {
    const raw = fs.readFileSync(tweePath, "utf8");
    const passages = new Map();
    let currentName = null;
    let currentTags = [];
    let currentLines = [];

    const flush = () => {
        if (!currentName) {
            return;
        }
        const content = currentLines.join("\n");
        passages.set(currentName, buildPassageModel(currentName, currentTags, content));
        currentName = null;
        currentTags = [];
        currentLines = [];
    };

    for (const line of raw.split(/\r?\n/)) {
        const headerMatch = line.match(PASSAGE_HEADER);
        if (headerMatch) {
            flush();
            currentName = headerMatch[1].trim();
            currentTags = headerMatch[2]
                ? headerMatch[2].split(/\s+/).filter(Boolean)
                : [];
            currentLines = [];
            continue;
        }
        if (currentName) {
            currentLines.push(line);
        }
    }
    flush();

    const passageNames = new Set(passages.keys());
    return { passages, passageNames };
}

/**
 * @param {string} name
 * @param {string[]} tags
 * @param {string} content
 */
function buildPassageModel(name, tags, content) {
    const { patientBlock, observerBlock, sharedBlock } = splitRoleBranches(content);
    const patientSource = patientBlock || sharedBlock || "";
    const observerSource = observerBlock || sharedBlock || "";

    const patient = extractPatientNavigation(patientSource, content);
    const observer = extractObserverMeta(observerSource);

    const routerBody = patientBlock ? patientSource : content;
    const autoTargets = extractAutoTargets(routerBody);
    const isRouter = autoTargets.length > 0 && !patient.hasNext && !patient.hasChoices;

    return {
        name,
        tags,
        patient,
        observer,
        autoTargets,
        isRouter,
        isTerminal: TERMINAL_PASSAGES.has(name),
        isSystem: SYSTEM_PASSAGES.has(name),
        hasRoleSplit: Boolean(patientBlock && observerBlock),
    };
}

/**
 * @param {string} content
 */
function splitRoleBranches(content) {
    const patientOpen =
        /<<if\s+(?:State\.variables\.)?\$?myRole\s*==\s*["']patient["'][^>]*>>/i;
    const openMatch = content.match(patientOpen);
    if (!openMatch) {
        return { patientBlock: null, observerBlock: null, sharedBlock: content };
    }

    const startIdx = openMatch.index + openMatch[0].length;
    const elseIdx = findRoleElseIndex(content, startIdx);

    if (elseIdx === -1) {
        const patientBlock = content
            .slice(startIdx)
            .replace(/<\/if>>\\?/gi, "")
            .trim();
        return { patientBlock, observerBlock: null, sharedBlock: null };
    }

    const patientBlock = content.slice(startIdx, elseIdx).trim();
    const afterElse = content.slice(elseIdx).replace(/^<<else>>\\?/i, "");
    const observerBlock = afterElse.replace(/<\/if>>\\?\s*$/i, "").trim();

    return { patientBlock, observerBlock, sharedBlock: null };
}

/**
 * Find <<else>> that pairs with the patient role <<if>>, not nested conditionals.
 * @param {string} content
 * @param {number} startIdx
 */
function findRoleElseIndex(content, startIdx) {
    let depth = 1;
    const tokenRe = /<<if\b[^>]*>>|<<elseif\b[^>]*>>|<<else>>\\?|<\/if>>\\?/gi;
    tokenRe.lastIndex = startIdx;
    let match;

    while ((match = tokenRe.exec(content)) !== null) {
        const token = match[0];
        if (/^<<if\b/i.test(token)) {
            depth++;
        } else if (/^<\/if>>/i.test(token)) {
            depth--;
            if (depth === 0) {
                return -1;
            }
        } else if (/^<<else>>/i.test(token) && depth === 1) {
            return match.index;
        }
    }

    return -1;
}

/**
 * @param {string} source
 * @param {string} fullContent
 */
function extractPatientNavigation(source, fullContent) {
    const scan = source || fullContent;
    const nextInfo = extractPatientNext(scan);
    const choicesInfo = extractPatientChoices(scan);

    const buttonTargets = [
        ...matchAllGroups(scan, /SimApp\.nextPassage\s*\(\s*["']([^"']+)["']\s*\)/g),
    ];

    const linkTargets = [
        ...matchAllGroups(
            scan,
            /goToSharedPassage\s*\(\s*["']([^"']+)["']\s*\)/g
        ),
    ];

    const autoTargets = extractAutoTargets(scan);

    const allTargets = unique([
        ...nextInfo.targets,
        ...choicesInfo.choiceTargets,
        ...buttonTargets,
        ...linkTargets,
        ...autoTargets,
    ]);

    return {
        hasNext: nextInfo.hasNext,
        nextTargets: nextInfo.targets,
        malformedNext: nextInfo.malformed,
        hasChoices: choicesInfo.hasChoices,
        skipEval: choicesInfo.skipEval,
        choiceTargets: choicesInfo.choiceTargets,
        buttonTargets: unique(buttonTargets),
        linkTargets: unique(linkTargets),
        allTargets,
    };
}

/**
 * @param {string} source
 */
function extractPatientNext(source) {
    const targets = [];
    const malformed = [];
    let hasNext = false;

    const macroRe = /<<patient-next\b/gi;
    let match;
    while ((match = macroRe.exec(source)) !== null) {
        hasNext = true;
        const rest = source.slice(match.index + match[0].length);
        const strings = [];
        let pos = 0;

        while (pos < rest.length && strings.length < 3) {
            const leading = rest.slice(pos).match(/^\s*/);
            pos += leading ? leading[0].length : 0;
            if (rest[pos] !== '"') {
                break;
            }
            const end = findClosingQuote(rest, pos);
            if (end === -1) {
                break;
            }
            strings.push(rest.slice(pos + 1, end));
            pos = end + 1;
        }

        const tail = rest.slice(pos).trim();
        if (strings.length >= 2 && /^>>/.test(tail)) {
            targets.push(strings[1]);
        } else {
            malformed.push(match[0] + rest.slice(0, Math.min(rest.length, 120)));
        }
    }

    return { hasNext, targets: unique(targets), malformed };
}

/**
 * @param {string} source
 */
function extractPatientChoices(source) {
    const openMatch = source.match(/<<patient-choices\b/i);
    if (!openMatch) {
        return { hasChoices: false, skipEval: false, choiceTargets: [] };
    }

    const afterOpen = source.slice(openMatch.index);
    const blockMatch = afterOpen.match(/<<patient-choices[\s\S]*?>>\s*\\?/i);
    if (!blockMatch) {
        return { hasChoices: false, skipEval: false, choiceTargets: [] };
    }

    const block = blockMatch[0];
    const firstNewline = block.indexOf("\n");
    const header = firstNewline === -1 ? block : block.slice(0, firstNewline);
    const body = firstNewline === -1
        ? ""
        : block
              .slice(firstNewline + 1)
              .replace(/>>\s*\\?\s*$/i, "");

    const skipEval = /["']no-eval["']/i.test(header);
    const choiceTargets = [];

    for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('"')) {
            continue;
        }
        const quoteEnd = findClosingQuote(trimmed, 0);
        if (quoteEnd === -1) {
            continue;
        }
        const inner = trimmed.slice(1, quoteEnd);
        const parts = inner.split("|").map((p) => p.trim());
        if (parts.length >= 6 && parts[5]) {
            choiceTargets.push(parts[5]);
        }
    }

    return {
        hasChoices: true,
        skipEval,
        choiceTargets: unique(choiceTargets),
    };
}

/**
 * @param {string} str
 * @param {number} start
 */
function findClosingQuote(str, start) {
    for (let i = start + 1; i < str.length; i++) {
        if (str[i] === "\\") {
            i++;
            continue;
        }
        if (str[i] === '"') {
            return i;
        }
    }
    return -1;
}

/**
 * @param {string} source
 */
function extractAutoTargets(source) {
    const defer = matchAllGroups(
        source,
        /SimApp\.deferGoToSharedPassage\s*\(\s*["']([^"']+)["']\s*\)/g
    );
    return unique(defer);
}

/**
 * @param {string} source
 */
function extractObserverMeta(source) {
    const hasDynamicEval = /<<dynamic-eval\b/i.test(source);
    let evalOptionCount = 0;
    const blockRe = /<<dynamic-eval\b[^>]*>>([\s\S]*?)<\/dynamic-eval>>/gi;
    const match = blockRe.exec(source);
    if (match) {
        for (const line of match[1].split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith('"')) {
                evalOptionCount++;
            }
        }
    }
    return { hasDynamicEval, evalOptionCount };
}

/**
 * @param {string} str
 * @param {RegExp} re
 */
function matchAllGroups(str, re) {
    const out = [];
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const globalRe = new RegExp(re.source, flags);
    let m;
    while ((m = globalRe.exec(str)) !== null) {
        if (m[1]) {
            out.push(m[1]);
        }
    }
    return out;
}

/**
 * @param {string[]} arr
 */
function unique(arr) {
    return [...new Set(arr.filter(Boolean))];
}

/**
 * @param {string} [tweePath]
 */
export function loadStory(tweePath) {
    const resolved =
        tweePath ||
        path.join(__dirname, "..", "COPD simulation 2.0.4.twee");
    return parseTweeFile(resolved);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { passages, passageNames } = loadStory();
    console.log(`Parsed ${passageNames.size} passages`);
    for (const [name, model] of passages) {
        if (model.isSystem) {
            continue;
        }
        console.log(name, model.patient.allTargets);
    }
}
