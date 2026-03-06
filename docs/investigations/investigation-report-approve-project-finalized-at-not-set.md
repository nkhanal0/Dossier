# Investigation: Approve Project — `finalized_at` Not Set (Flow Break)

**Date:** 2026-03-05  
**Symptom:** User clicked "Approve Project" for Task Manager. Button showed "Approving…" then reverted to "Approve Project". `GET /api/projects/:id` still returned `finalized_at: null`. Build path could not proceed.

**Conclusion:** The finalize flow **failed in the middle** (one or more of the 5 required context documents were not created). The API correctly returns 502 and **does not** set `finalized_at` on failure.

**Follow-up (this investigation):** The UI was updated to treat the 502 as a clear failure: the toast now includes `failed_docs` when present and tells the user to check server logs to investigate.

---

## 1. Flow (intended)

1. User clicks **Approve Project**.
2. Frontend calls `POST /api/projects/:projectId/chat` with `{ message: 'Finalize project', mode: 'finalize' }`.
3. Backend runs `runFinalizeMultiStep` (5 LLM steps in parallel: architectural-summary, project-scaffold, data-contracts, design-system, user-personas).
4. If **all** steps succeed and `artifactsCreated === totalDocs`:
   - Parse root folders from architectural-summary; clone repo if connected; create folders + scaffold; push.
   - `db.updateProject(projectId, { finalized_at: now })`.
   - Return 200 with `artifacts_created`, `status: "success"`.
5. If **any** step fails or returns 0 actions:
   - Return **502** with `failed_docs` and message; **do not** set `finalized_at`.
6. Frontend: if `!res.ok` → toast.error(message), return (no refetch). If res.ok → refetch, toast success/warning.

---

## 2. Root cause

- **Why `finalized_at` stayed null:** The finalize endpoint only sets `finalized_at` when `finalizeResult.failedDocs.length === 0` and `finalizeResult.artifactsCreated >= finalizeResult.totalDocs` (see `app/api/projects/[projectId]/chat/route.ts` lines 116–128 and 174). Otherwise it returns 502 and never reaches `db.updateProject(projectId, { finalized_at: now })`.
- **So the actual failure:** At least one of the 5 `runFinalizeMultiStep` steps either threw (LLM/network error) or returned 0 `createContextArtifact` actions. That could be:
  - LLM timeout or rate limit
  - LLM response not matching expected action shape (no `createContextArtifact`)
  - `runLlmSubStep` or planning prompt issue for one of the specs

---

## 3. Evidence

| Check | Result |
|-------|--------|
| Project after Approve | `GET /api/projects/a0be8fc0-019d-4968-9eaa-98b4e1f6a493` → `finalized_at: null` |
| Chat route success path | Only after passing `failedDocs.length === 0` and `artifactsCreated >= totalDocs` does it call `db.updateProject(projectId, { finalized_at: now })` (line 174) |
| Chat route failure path | Returns 502 with `message`, `artifacts_created`, `failed_docs`; no DB update |
| UI on !res.ok | Toasts `data.message ?? data.error`; does not show `failed_docs` or trigger investigation |

---

## 4. Recommendations

1. **Treat flow break as failure and investigate**
   - When Approve Project returns non-2xx, treat as **finalize failed**.
   - Surface **which** doc(s) failed: include `failed_docs` in the toast or a small inline error (e.g. "Finalize failed: architectural-summary, data-contracts"). That allows the user or support to know what to retry or debug.

2. **Server-side logging**
   - `runFinalizeMultiStep` already logs `[finalize] Doc generation failed for ${spec.name}: ${msg}` on catch. Ensure logs are visible (e.g. server stdout or log aggregation) so operators can see which spec failed and the error message.

3. **Optional: structured failure response**
   - Have the UI call out "Finalize failed" and e.g. "Failed documents: X, Y. Check server logs or retry." so the user knows to await/investigate instead of assuming success.

4. **Retry / partial success (product decision)**
   - Today: all 5 docs required for `finalized_at`. If product allows partial success (e.g. set `finalized_at` when 3/5 docs exist and architectural-summary exists), that would need an explicit product/UX decision and a change to the chat route condition.

---

## 5. Required behavior (for "await or call a failure and investigate")

- **When finalize fails (502):**
  - **Do not** set `finalized_at` (current behavior is correct).
  - **Do** treat as a failure: show a clear error and, where possible, which step/doc failed.
  - **Do** log server-side which spec failed and why.
- **Operator/developer:** On observing "Approve Project" with no `finalized_at` change, check server response (502) and server logs for `[finalize] Doc generation failed for ...` to identify the failing doc and error, then fix (e.g. LLM config, prompt, or retry).
