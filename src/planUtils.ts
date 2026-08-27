/**
 * Validation and normalization for the structured create_plan /
 * update_plan_task tools (Phase 3.3), which replaced a regex-based
 * markdown parser (extractPlan) that was defined but never actually
 * called anywhere in the codebase — the Plan panel UI was fully built
 * and working, but nothing populated it with real data for a fresh
 * conversation.
 */

export interface PlanTask {
  task: string;
  done: boolean;
}

/** Validates and normalizes a create_plan `tasks` argument into a clean PlanTask[], or returns an error message. */
export function buildPlanFromTasks(tasks: any): { plan: PlanTask[] } | { error: string } {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { error: `"tasks" must be a non-empty array of task description strings.` };
  }
  const cleaned = tasks
    .map((t) => (typeof t === "string" ? t.trim() : String((t && t.task) ?? "").trim()))
    .filter((t) => t.length > 0);
  if (cleaned.length === 0) {
    return { error: `no valid task strings in "tasks".` };
  }
  return { plan: cleaned.map((task) => ({ task, done: false })) };
}

/** Validates an update_plan_task index against the current plan's bounds. */
export function validatePlanIndex(plan: PlanTask[], index: any): { ok: true } | { ok: false; error: string } {
  if (typeof index !== "number" || !Number.isInteger(index) || !plan[index]) {
    const maxIdx = plan.length - 1;
    return { ok: false, error: `no task at index ${index}. The plan has ${plan.length} task(s)${maxIdx >= 0 ? ` (valid indices 0-${maxIdx})` : ""}.` };
  }
  return { ok: true };
}