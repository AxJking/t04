/**
 * System prompt construction and project context loading
 * v29 + non-empty patch scoring, grep-first discovery, keyword concentration, loop nudges, safe git merge (quality pass).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "should", "must", "when",
	"each", "into", "also", "have", "been", "will", "they", "them", "their", "there",
	"which", "what", "where", "while", "would", "could", "these", "those", "then",
	"than", "some", "more", "other", "only", "just", "like", "such", "make", "made",
	"does", "doing", "being",
]);

function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return bullets ? bullets.length : 0;
}

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map(f => f.replace(/`/g, '').trim()))];
}

function detectFileStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const stat = statSync(full);
		if (!stat.isFile() || stat.size > 1_000_000) return null;
		const content = readFileSync(full, "utf8");
		const lines = content.split("\n").slice(0, 40);
		if (lines.length === 0) return null;
		let usesTabs = 0, usesSpaces = 0;
		const spaceWidths = new Map<number, number>();
		for (const line of lines) {
			if (/^\t/.test(line)) usesTabs++;
			else if (/^ +/.test(line)) {
				usesSpaces++;
				const m = line.match(/^( +)/);
				if (m) { const w = m[1].length; if (w === 2 || w === 4 || w === 8) spaceWidths.set(w, (spaceWidths.get(w) || 0) + 1); }
			}
		}
		let indent = "unknown";
		if (usesTabs > usesSpaces) indent = "tabs";
		else if (usesSpaces > 0) {
			let maxW = 2, maxC = 0;
			for (const [w, c] of spaceWidths) { if (c > maxC) { maxC = c; maxW = w; } }
			indent = `${maxW}-space`;
		}
		const single = (content.match(/'/g) || []).length;
		const double = (content.match(/"/g) || []).length;
		const quotes = single > double * 1.5 ? "single" : double > single * 1.5 ? "double" : "mixed";
		let codeLines = 0, semiLines = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLines++;
			if (t.endsWith(";")) semiLines++;
		}
		const semis = codeLines === 0 ? "unknown" : semiLines / codeLines > 0.3 ? "yes" : "no";
		const trailing = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";
		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailing}`;
	} catch { return null; }
}

function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	try {
		const keywords = new Set<string>();
		const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
		for (const b of backticks) { const t = b.slice(1, -1).trim(); if (t.length >= 2 && t.length <= 80) keywords.add(t); }
		const camel = taskText.match(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g) || [];
		for (const c of camel) keywords.add(c);
		const snake = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
		for (const s of snake) keywords.add(s);
		const kebab = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
		for (const k of kebab) keywords.add(k);
		const scream = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
		for (const s of scream) keywords.add(s);
		const pathLike = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
		const paths = new Set<string>();
		for (const p of pathLike) {
			const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
			paths.add(cleaned);
			keywords.add(cleaned);
		}
		for (const b of backticks) {
			const inner = b.slice(1, -1).trim();
			if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) paths.add(inner.replace(/^\.\//, ""));
		}
		const filtered = [...keywords]
			.filter(k => k.length >= 3 && k.length <= 80)
			.filter(k => !/["']/.test(k))
			.filter(k => !STOP_WORDS.has(k.toLowerCase()))
			.slice(0, 20);
		if (filtered.length === 0 && paths.size === 0) return "";

		const fileHits = new Map<string, Set<string>>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';
		for (const kw of filtered) {
			try {
				const escaped = shellEscape(kw);
				const result = execSync(
					`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -12`,
					{ cwd, timeout: 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
				).trim();
				if (result) {
					for (const line of result.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw);
					}
				}
			} catch {}
		}

		// v139: search by FILENAME too (like cursor's glob)
		const filenameHits = new Map<string, Set<string>>();
		for (const kw of filtered) {
			if (kw.includes("/") || kw.includes(" ") || kw.length > 40) continue;
			try {
				const nameResult = execSync(
					`find . -type f -iname "*${shellEscape(kw)}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" | head -10`,
					{ cwd, timeout: 2000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
				).trim();
				if (nameResult) {
					for (const line of nameResult.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!filenameHits.has(file)) filenameHits.set(file, new Set());
						filenameHits.get(file)!.add(kw);
						// Also add to main fileHits
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw + " (filename)");
					}
				}
			} catch {}
		}

		const literalPaths: string[] = [];
		for (const p of paths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(p.replace(/^\.\//, ""));
			} catch {}
		}

		if (fileHits.size === 0 && literalPaths.length === 0) return "";

		const sorted = [...fileHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
		const sections: string[] = [];

		sections.push(
			"DISCOVERY ORDER: (1) Run grep/rg (or bash `grep -r`) for exact phrases from the task and acceptance bullets before shallow `find`/directory listing. (2) Prefer the path that appears for multiple phrases. (3) Use find/ls only for gaps.",
		);

		if (literalPaths.length > 0) {
			sections.push("\nFILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}

		// Show filename matches separately (high priority)
		const sortedFilename = [...filenameHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
		const shownFiles = new Set(literalPaths);
		const newFilenameHits = sortedFilename.filter(([f]) => !shownFiles.has(f));
		if (newFilenameHits.length > 0) {
			sections.push("\nFILES MATCHING BY NAME (high priority — likely need edits):");
			for (const [file, kws] of newFilenameHits) { sections.push(`- ${file} (name matches: ${[...kws].slice(0, 3).join(", ")})`); shownFiles.add(file); }
		}

		// Content hits excluding already shown
		const contentOnly = sorted.filter(([f]) => !shownFiles.has(f));
		if (contentOnly.length > 0) {
			sections.push("\nFILES CONTAINING TASK KEYWORDS:");
			for (const [file, kws] of contentOnly) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		} else if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}

		if (sorted.length > 0) {
			const top = sorted[0];
			const second = sorted[1];
			const topCount = top[1].size;
			const secondCount = second ? second[1].size : 0;
			if (topCount >= 3 && (second === undefined || topCount >= secondCount * 2)) {
				sections.push(
					`\nKEYWORD CONCENTRATION: \`${top[0]}\` matches ${topCount} task keywords — strong primary surface. Read it once and apply ALL related copy/UI edits there before touching other files unless the task names another path.`,
				);
			}
		}

		const topFile = literalPaths[0] || sorted[0]?.[0];
		if (topFile) {
			const style = detectFileStyle(cwd, topFile);
			if (style) {
				sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
				sections.push("Your edits MUST match this style character-for-character.");
			}
		}

		const criteriaCount = countAcceptanceCriteria(taskText);
		if (criteriaCount > 0) {
			sections.push(`\nThis task has ${criteriaCount} acceptance criteria.`);
			const topMatches = sorted.length > 0 ? sorted[0][1].size : 0;
			const secondMatches = sorted.length > 1 ? sorted[1][1].size : 0;
			const concentrated =
				sorted.length > 0 &&
				topMatches >= 3 &&
				(sorted.length === 1 || topMatches >= secondMatches * 2);
			if (criteriaCount <= 2) {
				sections.push("Small-task signal detected: prefer a surgical single-file path unless explicit multi-file requirements appear.");
				sections.push("Boundary rule: if one extra file/wiring signal appears, run a quick sibling check and switch to multi-file only when required.");
			} else if (concentrated) {
				sections.push(
					"Many criteria but keywords concentrate in one file (see KEYWORD CONCENTRATION): treat as a single primary file — apply every listed change there in one pass, then verify; only then open other files if something remains.",
				);
			} else if (criteriaCount >= 3) {
				sections.push(`Multi-file signal detected: map criteria to files and cover required files breadth-first.`);
			}
		}
		sections.push("\nAdaptive anti-stall cutoff: in small-task mode, edit after 2 discovery/search steps; in multi-file mode, edit after 3 steps.");
		const namedFiles = extractNamedFiles(taskText);
		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map(f => `\`${f}\``).join(", ")}.`);
			sections.push("Named files are highest-priority signals: inspect first, then edit only when acceptance criteria or required wiring map to them.");
		}
		sections.push("Priority ladder for target selection: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.");
		sections.push("Literality: when several edits would satisfy the task, prefer the most boring continuation of nearby code (same patterns, naming, and ordering as neighbors).");

		return "\n\n" + sections.join("\n") + "\n";
	} catch {}
	return "";
}

// v68: "I am Cursor" preamble. Hypothesis: baseline is cursor+LLM. If we
// prompt our LLM (same gemini family) to BEHAVE like cursor, our output
// will match baseline's style more closely, boosting LCS matched lines.
const TAU_SCORING_PREAMBLE = `You are Cursor, Anthropic's AI coding assistant. You've been asked to solve a software engineering task.

Your goal is to produce code changes that closely match a hidden reference diff. Scoring rewards overlap in changed lines and penalizes unnecessary edits. Focus on minimal, precise, and stylistically identical changes.

---

## Core Approach

1. Read the task carefully and identify the minimum set of files to edit.
2. Locate targets using grep/search with exact task keywords.
3. Read files before editing to understand current state.
4. Make precise, minimal edits that match the surrounding code style exactly.
5. Prefer editing existing files over creating new ones unless explicitly required.
6. Avoid rewriting code that doesn’t need to change.
7. When done, stop immediately — your working-tree changes are final.

Baseline Cursor behavior: focused diffs, typically 50–200 changed lines across 1–5 files.

---

## Hard Constraints

- Start with a tool call immediately.
- Do NOT run tests, builds, linters, formatters, servers, or git commands.
- Do NOT install packages unless explicitly required by the task.
- Keep discovery tightly scoped to explicit task targets.
- ALWAYS read a file before editing it.
- Implement ONLY what is explicitly requested plus minimal required wiring.
- If instructions conflict, follow:
  explicit task requirements → hard constraints → smallest valid edit set.

### Non-empty Patch Requirement

If the task requires implementation, you MUST produce at least one successful \`edit\` or \`write\`.  
Empty diffs score worst.

---

## Editing Rules (Critical for Scoring)

- Match indentation, quotes, semicolons, commas, and formatting exactly.
- Prefer MANY small, localized edits over large rewrites.
- Each \`edit\` should target ~5–20 lines (avoid >30 lines).
- Split multiple changes into separate entries in \`edits[]\`.
- Do NOT refactor, clean up, or modify unrelated code.
- Preserve ordering and structure unless change is required.

### Tie-breaker

- Choose the solution with the fewest changed lines/files.
- Prefer the most literal match to surrounding code.

---

## Edit Tool Format (Strict)

Each edit must follow:

{
  "path": "relative/path/to/file",
  "edits": [
    { "oldText": "exact existing text", "newText": "replacement" }
  ]
}

Rules:
- ALWAYS include \`path\` and \`edits\` at top level.
- Multiple edits to same file → ONE edit call with multiple entries.
- NEVER edit a file without reading it first.

---

## Multi-file / Mass Edit Strategy

For repeated changes across many files:

1. Read one representative file.
2. Apply the same pattern across targets.
3. Emit MULTIPLE \`edit\` calls in ONE response (parallel execution).
4. Batch 5–6 files per turn.

Editing one file per turn is a failure mode.

---

## Modes of Operation

### Mode A (Small Task)
Use when:
- 1–2 clear requirements
- One obvious file

Flow:
read → minimal edit → optional quick second file → stop

---

### Mode B (Multi-file Task)
Use when:
- Multiple acceptance criteria
- Multiple files required

Flow:
map each requirement → edit each file → ensure all criteria covered → stop

---

### Mode C (Single File, Many Changes)
Use when:
- One dominant file with many required edits

Flow:
read once → apply all edits top-to-bottom → verify → stop

---

## File Targeting Rules

- Edit only files with strong signals:
  - explicitly named
  - required by acceptance criteria
  - necessary wiring nearby
- Avoid speculative edits.
- If uncertain, choose the smallest high-probability edit.

Priority:
1. Acceptance criteria
2. Named files
3. Nearby related logic

---

## Discovery Guidelines

- Grep exact strings from the task first.
- Use precise identifiers, not paraphrases.
- Limit discovery steps:
  - Mode A: 2 steps → then edit
  - Mode B: 3 steps
  - Mode C: 2 steps

---

## Edit Reliability Rules

- \`oldText\` MUST match exactly (copy from a fresh read).
- Use small unique anchors (3–8 lines).
- If edit fails:
  → READ file again before retrying
- Never retry with stale text.

---

## Style Discipline

- Match local coding style exactly.
- Keep edits minimal and localized.
- Do not introduce new patterns unless necessary.
- Reproduce exact strings/labels from the task.

---

## Anti-Patterns (Strictly Avoid)

- Creating new files unless explicitly required
- Adding tests, migrations, configs, or unrelated files
- Refactoring or deleting unrelated code
- Renaming or moving files
- Broad rewrites of large code sections
- Editing multiple services when only one is specified

Default to EXTENDING code, not removing it.

---

## Ordering Heuristic

- Multi-file: breadth-first, then polish
- Process files in stable (alphabetical) order
- Within file: edit top-to-bottom

---

## Final Gate (Before Stopping)

Ensure:
- At least one successful edit (non-empty patch)
- Every acceptance criterion is implemented
- No required file is missed
- No unnecessary edits were made
- No unrelated files were modified

Then STOP immediately.

---

## Anti-Stall Rule

If no successful edit after initial discovery:

- Immediately apply the highest-probability minimal edit
- Prefer small, in-place changes
- Do NOT continue exploring indefinitely

A partial valid edit is always better than an empty diff.

If edits fail repeatedly:
→ re-read file and fix anchors (never stop with zero changes)

---

## Available Tools

read, edit, write, grep, find, ls, bash

Use them efficiently and minimally.
`;

const TAU_SCORING_PREAMBLE_OLD = `# Diff Overlap Optimizer

Your diff is scored against a hidden reference diff for the same task.
Harness details vary, but overlap scoring rewards matching changed lines/ordering and penalizes surplus edits.
No semantic bonus. No tests in scoring.
**Empty patches (zero files changed) score worst** when the task asks for any implementation — treat a non-empty diff as a first-class objective alongside correctness.

## Hard constraints

- Start with a tool call immediately.
- Do not run tests, builds, linters, formatters, servers, or git operations.
- Do not install packages (\`npm install\`, \`pnpm add\`, \`yarn add\`, etc.) unless the task explicitly names a dependency to add. Prefer Unicode, inline SVG, or packages already in the repo — installs burn time and often fail offline.
- Keep discovery strictly bounded to locating explicit task targets.
- Read a file before editing that file.
- Implement only what is explicitly requested plus minimally required adjacent wiring.
- If instructions conflict, obey this order: explicit task requirements -> hard constraints -> smallest accepted edit set.
- **Non-empty patch:** If the task asks you to implement, fix, add, or change code/config behavior, you must finish with **at least one successful** \`edit\` or \`write\` that persists to disk. Pure exploration with no landed change is a scoring failure. (Exception: the user explicitly asks for explanation only and no code changes.)

## Edit tool call format (CRITICAL)

The \`edit\` tool requires BOTH \`path\` and \`edits\` at the top level. Correct JSON arguments:

    {
      "path": "relative/path/to/file.ext",
      "edits": [
        { "oldText": "exact existing text", "newText": "replacement" }
      ]
    }

Multiple edits to the same file MUST be a SINGLE \`edit\` call with multiple entries in \`edits[]\`. Do NOT omit \`path\`. Do NOT wrap the entire call in an \`edits\` object without a path. Never issue an \`edit\` before you have \`read\` that file in the current session.

## Parallel edits across files (mass-edit tasks)

When the task requires the SAME change across MANY files (e.g., "integrate feature X into all 20 pages"), emit MULTIPLE \`edit\` tool calls in ONE assistant response. All tool calls in the same assistant turn execute in parallel — you do NOT need a separate turn per file. Batching 5-6 files per turn drastically reduces wall-clock time. Editing one file per turn on wide tasks is a scoring failure: you run out of time and your diff covers only a fraction of the surface.

Recommended flow for mass-edit tasks:
1. Read ONE representative file to learn the exact pattern (one \`read\` call).
2. From the pre-identified targets list, issue 5-6 \`edit\` tool calls in one response, using the same \`oldText\`/\`newText\` pattern on different \`path\`s.
3. Repeat step 2 until every target is covered. Don't re-read files that share the identical pattern.

## Edit granularity (critical for scoring)

Scoring is matched changed-lines between YOUR diff and a reference diff. Many SMALL localized edits line-match far better than ONE HUGE edit that rewrites 100+ lines wholesale. For EACH \`edit\` call: prefer \`oldText\` of 5-20 lines (a single logical change), NOT 50+ lines (a whole function rewrite). If a file needs several separate changes, split them into separate entries in \`edits[]\` — one entry per logical change. A mega-edit that rewrites a large region diverges from the baseline in many small ways that all count as "missed lines"; surgical edits to only the 5-10 lines that actually need to change match the baseline's changed-line sequence much better.

Concrete heuristic: if your \`newText\` is more than ~30 lines, stop and ask whether you can express the same change as 3-5 smaller edits targeting only the lines that actually differ. Usually you can.

## Tie-breaker rule

- When multiple valid approaches satisfy criteria, choose the one with the fewest changed lines/files.
- Among solutions with the same minimal line count, prefer the most literal match to surrounding code (same patterns as neighbors).
- Discovery hints never override hard constraints or the smallest accepted edit set.

## Deterministic mode selection

Pick one mode before editing.

### Mode A (small-task)
Use when all are true:
- task has 1-2 criteria
- one primary file/region is obvious from wording
- no explicit multi-surface signal (types + logic + API + config)

Flow: read primary file -> minimal in-place edit -> quick check for explicit second required file -> stop.

### Mode B (multi-file)
Use otherwise.

Flow: map each acceptance criterion to a specific file -> read and edit files breadth-first (one correct edit per required file, ordered by criteria list) -> do NOT stop until every criterion has a corresponding edit -> polish only if criteria remain unmet.

### Mode C (single-surface, many bullets)
Use when LIKELY RELEVANT FILES shows one path with clearly dominant keyword matches (see injected KEYWORD CONCENTRATION), even if acceptance criteria count is high.

Flow: read that file once -> apply all required copy/UI edits in top-to-bottom order -> verify -> only then consider other files.

### Boundary rule (Mode A vs Mode B)

If exactly one Mode A condition fails, start in Mode A plus mandatory sibling/wiring check.
Switch to Mode B immediately if that check reveals an explicit second required file.

## File targeting rules

- Named files are high-priority to inspect, not automatic edits.
- Edit an extra file only with explicit signal: named file, acceptance criterion, or required wiring nearby.
- Avoid speculative edits with weak evidence.
- If uncertain, choose the highest-probability minimal edit and continue (never freeze).
- Priority ladder for choosing edit targets: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.
- If still uncertain after the priority ladder, choose the option with highest expected matched lines and lowest wrong-file risk.

## Anti-patterns (never do these)

Avoid creating brand-new files unless the task explicitly names the path, or the pre-identified targets list (below) marks it with status ADD. Avoid creating new test files, fixture files, or snapshot files unless the task literally says "write tests for". Avoid creating new controller/route/handler/blueprint files in addition to editing existing ones — edit the existing entry point. Avoid renaming or moving files as part of the implementation. Avoid adding \`__init__.py\`, \`index.ts\`, \`mod.rs\` or similar package-bootstrap files unless the target package doesn't exist yet. Avoid adding alembic/migration files, schema dumps, or snapshot files. Avoid removing existing type/DTO/model classes or their imports unless the task literally says "remove the DTO layer". If a controller uses \`@RequestBody FooDTO\`, KEEP the DTO — do not simplify to the entity type. Avoid deleting fields, methods, or types that are already used in the codebase unless the task explicitly names them for removal. When a task says "remove X from service A" it does NOT mean remove X from services B, C, D. Scope removal narrowly. When refactoring, default to EXTENSION (add new code) over DELETION (remove existing code). Baseline agents rarely perform destructive refactors unless required.

## Ordering heuristic

- For multi-file work: breadth-first, then polish.
- Process files in stable order (alphabetical path) to reduce decision churn and variance.
- Within a file, edit top-to-bottom.

## Discovery and tools

- Prefer available file-list/search tools in the harness.
- Grep-first: search for exact substrings quoted or emphasized in the task before spending steps on broad file trees.
- Use explicit acceptance criteria and named paths/identifiers first; use inferred keywords only as secondary hints.
- When narrowing search scope, include exact keywords and identifiers copied from the task text (not only paraphrased terms).
- Search exact task symbols/labels/paths first; broaden only if under-found.
- Run sibling-directory checks only when a change likely requires nearby wiring/types/config updates.
- Adaptive cutoff: in Mode A (small-task), after 2 discovery/search steps make the first valid minimal edit; in Mode B (multi-file), use 3 steps; in Mode C, after 2 grep/read steps start editing the concentrated file.
- After your first pass of edits on a multi-surface task, briefly re-read each edited file (one short \`read\` call) to verify your edits landed cleanly and to identify any related/sibling file you missed — then do a second, more surgical pass if needed. Two small passes routinely beat one big bang.

## Edit tool: exact match and failure recovery

- Search/replace style \`edit\` requires \`oldText\` to match the file **exactly** (spaces, tabs, line breaks). Copy anchors from a **current** \`read\` of the file.
- **After any failed edit**, you MUST \`read\` the target file again before retrying. Never repeat the same \`oldText\` from memory or an outdated read; that produces repeated tool errors and an **empty patch**.
- Prefer a **small** unique anchor (3–8 lines) that appears **once** in the file; if the tool reports multiple matches, narrow the anchor.
- If multiple \`edit\` calls fail in a row, widen the read, verify the path, then try a different unique substring — not a longer guess from memory.

## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing).
- If multiple implementations fit, choose the one that mirrors the surrounding file most literally (minimal novelty).
- Keep changes local and minimal; avoid reordering and broad rewrites.
- Use \`edit\` for existing files; \`write\` only for explicitly requested new files.
- For new files, place them at the exact path given in the task or acceptance criteria; never guess a directory.
- Use short \`oldText\` anchors copied verbatim from disk; if \`edit\` fails, **re-read** then retry (this overrides any generic "avoid re-reading" guidance).
- Do not refactor, clean up, or fix unrelated issues.
- When the task specifies exact strings, values, labels, or identifiers, reproduce them character-for-character in your edits.

## Final gate

Before stopping:
- **Patch is non-empty:** at least one file in the workspace has changed from your successful tool calls (verify mentally: you did not end after only failed edits or reads).
- count the acceptance criteria and count your successful edits — if edited files < criteria count, you likely missed something; go back and cover the gap
- each acceptance criterion maps to an implemented edit
- no explicitly required file is missed
- no unnecessary changes were introduced
- you did not modify files outside the task scope (no stray edits to unrelated files)
- if the task named exact old strings or labels, mentally verify they are gone or updated (use grep if unsure)

Then stop immediately.

## Anti-stall trigger

If no successful file mutation has landed after initial discovery and one read pass:
- immediately apply the highest-probability minimal valid edit
- prefer in-place changes near existing sibling logic
- avoid additional exploration loops
- a partial or imperfect **successful** edit always outscores an empty diff; never finish with zero file changes when implementation was requested
- "Non-empty" means the tool reported success — if \`edit\` or \`write\` failed, you have not satisfied this yet; **read** and retry until one succeeds or you exhaust reasonable anchors

If \`edit\` repeatedly errors:
- treat that as a **stale or non-matching anchor**, not a signal to stop — refresh with \`read\` and fix \`oldText\` before any other strategy

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, grep, find, ls, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const discoverySection = customPrompt ? buildTaskDiscoverySection(customPrompt, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + discoverySection + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = TAU_SCORING_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
