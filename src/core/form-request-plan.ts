const admittedPlans = new WeakSet<object>()

export function admitFormRequestPlan<T extends object>(plan: T): T {
  admittedPlans.add(plan)
  return plan
}

export function isAdmittedFormRequestPlan(value: unknown): value is object {
  return typeof value === "object" && value !== null && admittedPlans.has(value)
}
