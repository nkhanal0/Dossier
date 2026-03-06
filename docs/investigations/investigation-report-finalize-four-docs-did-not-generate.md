# Investigation: Why Four Finalize Docs Did Not Generate

**Date:** 2026-03-05  
**Context:** Follow-up to [investigation-report-approve-project-finalized-at-not-set](investigation-report-approve-project-finalized-at-not-set.md). Re-running finalize (POST chat with `mode: "finalize"`) returned `artifacts_created: 2` and `failed_docs: ["architectural-summary", "data-contracts", "domain-summaries", "project-scaffold"]`. Two docs succeeded: **user-workflow-summaries**, **design-system**.

**Goal:** Identify why those four specs produce 0 `createContextArtifact` actions so we can fix or mitigate.

---

## 1. Code path (summary)

- **Entry:** `POST /api/projects/:projectId/chat` with `mode: "finalize"` → `runFinalizeMultiStep`.
- **Per doc:** `runLlmSubStep` with `buildFinalizeDocSystemPrompt(spec)` and `buildFinalizeDocUserMessage(state, spec)`, `actionFilter: (a) => a.action_type === "createContextArtifact"`.
- **Streaming:** `claudeStreamingRequest` → `parseActionsFromStream` (expects wrapper `{ "type": "actions", "actions": [...] }` or single-action object).
- **Outcome:** A doc “fails” (counted in `failed_docs`) if the step **throws** or returns **actionCount === 0** (no createContextArtifact applied).

So for each failing spec we get either:
- an **exception** (timeout, rate limit, network), or
- **0 actions** because: no valid action parsed, or validation rejected, or apply rejected.

---

## 2. Hypotheses for 0 actions

| # | Hypothesis | How it would show up |
|---|------------|----------------------|
| **A** | **Truncated JSON (max_tokens)** | LLM output cuts off before closing `}"` or `]}`. `extractJsonObject` / `JSON.parse` fails; parser yields no actions. More likely for longer docs (architectural-summary, project-scaffold, data-contracts). |
| **B** | **Invalid JSON (content field)** | Single `createContextArtifact` with large `content` string; unescaped newlines/quotes or control chars break JSON. Parser fails → 0 actions. |
| **C** | **LLM returns clarification** | Response has `response_type: "clarification"`. We skip actions and return 0. Unlikely for “write this doc” instructions but possible if model asks for input. |
| **D** | **Validation reject** | Action parsed but `validatePlanningOutput` rejects (e.g. schema, card_id, or `containsCodeGenerationIntent`). We log and skip; actionCount stays 0. |
| **E** | **Apply reject** | Action applied via `pipelineApply`; `applyAction` returns `rejectionReason` (e.g. **code-generation intent** in payload). We don’t increment actionCount. `CODE_GEN_PATTERNS` in `lib/db/mutations.ts` can match phrases in doc content (e.g. “implement the function”, “create a file that contains”). |
| **F** | **Timeout / exception** | Step throws (e.g. idle timeout in `claudeStreamingRequest`). Caught in `runFinalizeMultiStep`, spec added to `failedDocs`. |

---

## 3. Changes made (diagnostics)

1. **Step label in logs**
   - `runLlmSubStep` now accepts optional `stepLabel` (e.g. finalize doc name).
   - When **actionCount === 0**, the existing “0 actions” warn log includes `(stepLabel)` and the raw output tail.
   - When the LLM returns **clarification**, the warn log includes `(stepLabel)`.
   - When **validation** or **apply** fails, we `console.warn` with `(stepLabel)` and the reason.

2. **Finalize passes spec name**
   - `runFinalizeMultiStep` calls `runLlmSubStep` with `stepLabel: spec.name` for each of the 6 specs.

**Next run:** After triggering finalize again, server logs will show which spec produced 0 actions and whether the cause was clarification, validation reject, apply reject, or parse failure (with raw tail). That will confirm which of A–F applies.

---

## 4. Root cause confirmed (2026-03-05)

Live finalize was run; server logs showed:

- **architectural-summary:** `[planning] Validation rejected (architectural-summary): Planning actions cannot generate production code. Code generation must be deferred to orchestration phase.`
- **design-system:** same message.

**Cause:** Hypothesis **D** (validation reject). The LLM was producing valid `createContextArtifact` JSON. The **code-generation-intent** check (`containsCodeGenerationIntent` in validation, `isCodeGenerationIntent` in apply) was matching phrases inside the doc **content** (e.g. "Implementation", "Add unit tests", "Implement the API") and rejecting the action. Finalize docs are descriptive context (architecture, design); they are not code-generation actions.

**Fix applied:** Project-level finalize docs are now exempt from the code-gen check:

- **`lib/schemas/planning-state.ts`:** Added `isProjectLevelDocArtifact(actionType, payload)` — true when `action_type === "createContextArtifact"`, `card_id` is null/empty, and `type` is `"doc"`, `"design"`, or `"architectural_summary"`. `containsCodeGenerationIntent` returns false for these.
- **`lib/db/mutations.ts`:** In `applyAction`, the same exemption is applied so project-level doc/design artifacts are not rejected at apply time.

Other failed docs (data-contracts, domain-summaries, project-scaffold) may have failed for the same reason if their content triggered the patterns, or for parse/truncation; re-running finalize after this fix will confirm.

---

## 6. Recommended next steps (if issues remain)

1. **Reproduce and capture logs**
   - Trigger finalize again (same project or a clone).
   - Inspect server logs for lines like:
     - `[planning] LLM sub-step produced 0 actions (architectural-summary). Length: ... Tail: ...`
     - `[planning] Validation rejected (architectural-summary): ...`
     - `[planning] Apply failed (architectural-summary): ...`
   - From the “Tail” and “Raw output” snippets, determine if JSON is truncated (A) or malformed (B).

2. **If A (truncation):**
   - Increase `maxTokens` for finalize steps (e.g. pass a higher value from `runFinalizeMultiStep` to `runLlmSubStep`; current default in `claudeStreamingRequest` is 16384).
   - Optionally shorten or split prompts so each doc stays under the limit.

3. **If B (invalid JSON):**
   - Tighten finalize prompts: require valid JSON, escape newlines in `content`, or constrain length.
   - Optionally add a fallback in the parser for common LLM mistakes (e.g. unescaped newlines in strings) if feasible without encouraging bad output.

4. **If D/E (validation or apply reject):**
   - For **code-generation intent** on context artifacts: consider exempting or relaxing the check for `createContextArtifact` with type `design_doc` / `architectural_summary` / etc., so descriptive text (e.g. “implement the API”) in docs doesn’t trigger rejection.
   - Fix any schema/card_id validation that incorrectly rejects project-level artifacts (card_id null).

5. **If F (timeout):**
   - Increase streaming timeout or reduce prompt size for the heaviest specs.

---

## 7. Specs reference

| Spec name | Purpose (from FINALIZE_DOC_SPECS) |
|-----------|-----------------------------------|
| architectural-summary | Root folder structure, key patterns, tech_stack |
| data-contracts | API/data shapes and contracts |
| domain-summaries | Domain concepts and terminology |
| user-workflow-summaries | User flows and outcomes |
| design-system | Design tokens, components, patterns |
| project-scaffold | File/folder listing for scaffold |

Failed in the observed run: **architectural-summary**, **data-contracts**, **domain-summaries**, **project-scaffold**.  
Succeeded: **user-workflow-summaries**, **design-system**.

---

**Status:** Root cause confirmed (validation code-gen check on doc content). Fix applied: project-level doc/design artifacts exempt from code-generation check. Re-run finalize to verify all six docs now create successfully.
