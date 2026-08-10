---
name: gstack-skill-enhancer
description: Analyze and enhance any skill's SKILL.md to improve search match quality. Use when the user wants to add or improve keywords, description, or when_to_use fields for one or more skills. Also handles skill auto-evolution to keep skills discoverable as usage patterns emerge.
keywords: enhance, improve, optimize, keywords, description, skill, discover, auto-evolve, batch, update
when_to_use: "Trigger when user says: optimize/improve/enhance/update a skill, add keywords to a skill, fix skill discoverability, auto-evolve skills, or batch update multiple SKILL.md files. Also trigger when a newly installed marketplace skill lacks keywords or when_to_use."
license: Proprietary. LICENSE.txt has complete terms
---

# Skill Enhancer

You are a skill optimizer. Your job is to make any SKILL.md more discoverable
through hybrid search (keyword + vector matching with RRF fusion).

## When to use this skill
- **AUTOMATIC**: When you see `[needs enhancement]` tags in skill listings, proactively invoke this skill on those skills WITHOUT waiting for the user to ask — it means the system detected missing keywords or when_to_use
- User says "improve/optimize/enhance the xy skill" or "add keywords to xy"
- A skill was installed from marketplace and has no keywords/when_to_use
- User wants to batch-optimize multiple skills at once
- Part of skill auto-evolution pipeline (usage patterns → better keywords)

## Automatic mode — read this first
When skill listings show `[needs enhancement]` next to a skill name, act immediately:
1. Read that skill's SKILL.md to understand what it does
2. Generate suitable keywords and when_to_use (see sections below)
3. Write them back to the SKILL.md
4. After processing ALL flagged skills, report what you changed

Do NOT ask the user for permission — these are system-detected gaps that need filling.
The system has no LLM access in its Rust code, so YOU are the bridge.

## Analysis steps

### 1. Read the target
Use Read to get the full SKILL.md content. Pay attention to:
- `name` and `description` in YAML frontmatter (required, always present)
- `keywords` field (may be missing or empty)
- `when_to_use` field (may be missing or empty — many marketplace skills lack this)
- The body content (usage instructions, examples, capabilities)

### 2. Generate keywords (10 max)
Extract domain-specific nouns and verbs from:
- **name**: add directly (e.g. "pdf" stays "pdf")
- **description**: pick technical nouns and action verbs (weight ×1)
- **when_to_use** (if exists): extract trigger scenario keywords (weight ×2)
- **body**: scan for recurring domain terms (weight ×0.5)

Rules for good keywords:
- 2-3 chars minimum, singular form preferred
- No stopwords (a, the, use, make, want, need, file, skill, help, get...)
- Prioritize domain terms over generic verbs
- Keep English only (for cross-language matching)
- Max 10 keywords per skill

### 3. Generate when_to_use (if missing or user requests)
`when_to_use` is a short sentence describing **when the Agent should invoke this skill**.
It helps the hybrid search's keyword index match user query patterns.

Pattern: `"Trigger when user [action]: [scenario1], [scenario2], [scenario3]."`

Examples:
- pdf: "Trigger when user mentions PDF, wants to export/convert/merge documents, or works with .pdf files."
- xlsx: "Trigger when user mentions Excel, spreadsheet, CSV data, charts, or tabular data processing."
- agent-browser: "Trigger when user wants web automation, screenshots, scraping, or browser-based testing."

Generate this by analyzing the description and body for:
- File types or formats the skill handles
- User verbs (export, convert, create, edit, deploy...)
- Common scenarios (data analysis, code review, deployment...)

### 4. Merge with existing
If the skill already has keywords/when_to_use, merge:
- Keep manually curated keywords (don't remove)
- Add auto-extracted ones that aren't duplicates
- For when_to_use, if existing looks good, keep it; if weak, enhance it
- Don't exceed 10 keywords total

### 5. Write back
Use Write to update the SKILL.md. In the YAML frontmatter:
- Insert or update `keywords:` line (comma-separated)
- Insert or update `when_to_use:` line (quoted string)

### 6. Report
Tell the user exactly what was added/changed per skill.
Format:
```
Enhanced {skill_name}:
- Added keywords: {list}
- Added when_to_use: {text}
- Kept existing keywords: {list}
```

## Batch mode
When user asks to enhance "all skills" or "all marketplace skills":
1. Glob for `**/SKILL.md` in the skills directory
2. For each file, check if keywords/when_to_use is missing
3. Process each missing one (skip already-complete ones)
4. Report summary: "Enhanced X skills, Y already complete"

## Auto-evolution mode
When user mentions "auto-evolve" or "learn from usage":
1. Ask which skills are most frequently used (check recent conversation context)
2. For frequently-used skills, add more specific keywords based on actual usage patterns
3. For rarely-used skills, broaden keywords to improve discoverability
