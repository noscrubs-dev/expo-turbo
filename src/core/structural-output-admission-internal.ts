import type { DocumentSession } from "./session.js"
import type { ProtocolNode } from "./tree.js"

export interface StructuralOutputAdmissionRequest {
  readonly kind: "frame" | "stream"
  readonly nodes: readonly ProtocolNode[]
}

export interface StructuralOutputAdmissionResult {
  readonly hasOutput: boolean
  readonly hasVocabularyIssues: boolean
  report(): void
}

export type StructuralOutputAdmission = (
  request: StructuralOutputAdmissionRequest,
) => StructuralOutputAdmissionResult

interface StructuralOutputAdmissionRegistration {
  readonly admission: StructuralOutputAdmission
  readonly token: object
}

const structuralOutputAdmissions = new WeakMap<
  DocumentSession,
  StructuralOutputAdmissionRegistration[]
>()

export function registerStructuralOutputAdmission(
  session: DocumentSession,
  admission: StructuralOutputAdmission,
): () => void {
  const registration = Object.freeze({ admission, token: Object.freeze({}) })
  const registrations = structuralOutputAdmissions.get(session) ?? []
  registrations.push(registration)
  structuralOutputAdmissions.set(session, registrations)
  let active = true
  return () => {
    if (!active) return
    active = false
    const current = structuralOutputAdmissions.get(session)
    if (!current) return
    const index = current.findIndex((candidate) => candidate.token === registration.token)
    if (index === -1) return
    current.splice(index, 1)
    if (current.length === 0) structuralOutputAdmissions.delete(session)
  }
}

/**
 * Combines every mounted admission conservatively: any renderable verdict wins,
 * so nested providers with different registries can never discard content one of
 * them could render. The result does not depend on effect-commit order.
 */
export function admitStructuralOutput(
  session: DocumentSession,
  request: StructuralOutputAdmissionRequest,
): StructuralOutputAdmissionResult | undefined {
  const registrations = structuralOutputAdmissions.get(session)
  if (!registrations || registrations.length === 0) return undefined
  const results = registrations.map((registration) => registration.admission(request))
  return Object.freeze({
    hasOutput: results.some((result) => result.hasOutput),
    hasVocabularyIssues: results.some((result) => result.hasVocabularyIssues),
    report() {
      for (const result of results) result.report()
    },
  })
}
