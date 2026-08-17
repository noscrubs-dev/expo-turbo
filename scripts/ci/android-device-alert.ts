import { readFile } from "node:fs/promises"

export const ANDROID_WORKFLOW = "android-device.yml"
export const ANDROID_WORKFLOW_PATH = `.github/workflows/${ANDROID_WORKFLOW}`
export const EXPECTED_REPOSITORY = "noscrubs-dev/expo-turbo"
export const ALERT_LABEL = "android-device-ci-alert"
export const ALERT_MARKER = "<!-- expo-turbo-android-device-alert:v1 -->"
export const STATE_PREFIX = "<!-- expo-turbo-android-device-alert-state:v2:"
export const DUPLICATE_MARKER = "<!-- expo-turbo-android-device-alert:duplicate -->"
export const RECOVERY_MARKER = "<!-- expo-turbo-android-device-alert:recovery -->"
export const WORKFLOW_TIMEOUT_MINUTES = 90
export const RUN_STALE_HOURS = 3
export const COMPLETED_STALE_HOURS = 24
const MAX_HISTORY = 10
const MAX_COMMENT_PAGES = 10
const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"])

const conclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
])

export type AlertState = "red" | "green" | "ignored"

export interface WorkflowRun {
  id: number
  event: string
  path: string
  status: string
  conclusion: string | null
  headBranch: string
  headSha: string
  createdAt: string
  updatedAt: string
}

export interface Decision {
  state: AlertState
  reason: string
  run?: WorkflowRun
}

export interface AlertIssue {
  number: number
  body: string
}

export type Operation =
  | { kind: "ensure-label" }
  | { kind: "create" }
  | { kind: "update"; issue: number }
  | { kind: "recover-comment"; issue: number }
  | { kind: "duplicate-comment"; issue: number; canonical: number }
  | { kind: "close"; issue: number }

interface AlertConfig {
  token: string
  repository: string
  serverUrl: string
  eventName: string
  eventPath: string
  dryRun: boolean
}

interface HistoryRow {
  at: string
  state: "red" | "green"
  reason: string
  runId: number | null
}

interface StoredState {
  version: 1
  redCount: number
  history: HistoryRow[]
}

interface ParsedState {
  value: StoredState
  corrupt: boolean
}

type FetchLike = typeof fetch

export class GitHubApi {
  readonly writes: Array<{ method: string; path: string; body: unknown }> = []

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
    private readonly dryRun: boolean,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (WRITE_METHODS.has(method)) {
      this.writes.push({ method, path, body })
      if (this.dryRun) return { dry_run: true }
    }

    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await this.fetchImpl(`https://api.github.com${path}`, init)

    const text = await response.text()
    const payload = text === "" ? null : JSON.parse(text)
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${path} returned ${response.status}`)
      Object.assign(error, { status: response.status, payload })
      throw error
    }
    return payload
  }
}

export async function determineDecision(
  api: GitHubApi,
  repository: string,
  eventName: string,
  event: unknown,
  now = new Date(),
): Promise<Decision> {
  const base = `/repos/${repository}`
  if (eventName === "workflow_run") {
    const eventRunId = positiveInteger(
      objectField(objectField(event, "workflow_run"), "id"),
      "workflow_run.id",
    )
    const run = parseRun(await api.request("GET", `${base}/actions/runs/${eventRunId}`))
    if (run.headBranch !== "main") return ignored("The event run is not from main.")
    if (run.status !== "completed") return ignored("The event run is not complete.")

    const completed = parseRuns(
      await api.request(
        "GET",
        `${base}/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&status=completed&per_page=20`,
      ),
    ).filter(isRecoveryCandidate)
    if (
      completed.some(
        (candidate) =>
          dateMs(candidate.createdAt) > dateMs(run.createdAt) ||
          (candidate.createdAt === run.createdAt && candidate.id > run.id),
      )
    ) {
      return ignored("A newer completed Android run exists.")
    }
    if (!isRecoveryCandidate(run)) {
      return ignored("The event run is not an eligible main push run.")
    }
    return verifyGreenRecovery(api, repository, await classifyCompleted(api, repository, run))
  }

  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    return ignored("This event is not supported.")
  }

  const runs = parseRuns(
    await api.request(
      "GET",
      `${base}/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`,
    ),
  )
    .filter(isRecoveryCandidate)
    .sort(compareRunsNewestFirst)

  const newest = runs[0]
  if (!newest) return red("No Android workflow run exists.")
  if (newest.status !== "completed") {
    const age = now.getTime() - dateMs(newest.createdAt)
    if (age >= RUN_STALE_HOURS * 60 * 60 * 1000) {
      return red(`The Android run has not completed within ${RUN_STALE_HOURS} hours.`, newest)
    }
    return ignored("The newest Android run is still active within its allowed window.")
  }

  const classified = await classifyCompleted(api, repository, newest)
  if (classified.state === "red") return classified

  const completedAge = now.getTime() - dateMs(newest.updatedAt)
  if (classified.state === "green") {
    const current = await verifyGreenRecovery(api, repository, classified)
    if (current.state !== "green") {
      if (completedAge >= COMPLETED_STALE_HOURS * 60 * 60 * 1000) {
        return red(
          `The newest completed Android run is over ${COMPLETED_STALE_HOURS} hours old and main has newer commits.`,
          newest,
        )
      }
      return current
    }
    if (completedAge < COMPLETED_STALE_HOURS * 60 * 60 * 1000) return current
    return green("The last Android run is old, but main has no newer commit.", newest)
  }

  if (completedAge >= COMPLETED_STALE_HOURS * 60 * 60 * 1000) {
    const mainSha = await loadMainSha(api, repository)
    if (mainSha !== newest.headSha) {
      return red(
        `The newest completed Android run is over ${COMPLETED_STALE_HOURS} hours old and main has newer commits.`,
        newest,
      )
    }
  }
  return classified
}

async function verifyGreenRecovery(
  api: GitHubApi,
  repository: string,
  decision: Decision,
): Promise<Decision> {
  if (decision.state !== "green" || !decision.run) return decision
  const mainSha = await loadMainSha(api, repository)
  if (mainSha !== decision.run.headSha) {
    return ignored("The successful Android run does not test the current main commit.")
  }
  return decision
}

async function loadMainSha(api: GitHubApi, repository: string): Promise<string> {
  try {
    const mainCommit = recordValue(
      await api.request("GET", `/repos/${repository}/commits/main`),
      "main commit",
    )
    const mainSha = stringField(mainCommit, "sha")
    if (!/^[0-9a-f]{40}$/.test(mainSha)) throw new Error("main commit sha is invalid")
    return mainSha
  } catch (error) {
    const diagnostic = sanitizeCodeSpan(error instanceof Error ? error.message : "unknown error")
    throw new Error(`main commit lookup failed: ${diagnostic}`)
  }
}

function isRecoveryCandidate(run: WorkflowRun): boolean {
  return run.event === "push" && run.path === ANDROID_WORKFLOW_PATH && run.headBranch === "main"
}

function compareRunsNewestFirst(left: WorkflowRun, right: WorkflowRun): number {
  const timestampOrder = dateMs(right.createdAt) - dateMs(left.createdAt)
  if (timestampOrder !== 0) return timestampOrder
  if (right.id === left.id) return 0
  return right.id > left.id ? 1 : -1
}

export async function classifyCompleted(
  api: GitHubApi,
  repository: string,
  run: WorkflowRun,
): Promise<Decision> {
  if (run.status !== "completed") return ignored("The Android run is not complete.")
  switch (run.conclusion) {
    case "success":
      return green("The Android workflow completed successfully.", run)
    case "failure":
    case "timed_out":
    case "startup_failure":
      return red(`The Android workflow concluded ${run.conclusion}.`, run)
    case "cancelled": {
      const jobs = parseJobs(
        await api.request(
          "GET",
          `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        ),
      )
      const timeoutMs = WORKFLOW_TIMEOUT_MINUTES * 60 * 1000
      if (jobs.some((job) => job.durationMs >= timeoutMs)) {
        return red(`The Android job reached its ${WORKFLOW_TIMEOUT_MINUTES}-minute timeout.`, run)
      }
      return ignored("The cancelled run had no job at the timeout threshold.")
    }
    default:
      return ignored(
        `The Android workflow conclusion ${run.conclusion ?? "null"} is not alertable.`,
      )
  }
}

export function planTransition(decision: Decision, issues: AlertIssue[]): Operation[] {
  if (decision.state === "ignored") return []
  const numbers = issues.map((issue) => issue.number).sort((a, b) => a - b)
  if (decision.state === "green") {
    if (numbers.length === 0) return []
    const canonical = numbers.at(0)
    if (canonical === undefined) return []
    return [
      { kind: "recover-comment", issue: canonical },
      ...numbers
        .slice()
        .sort((a, b) => b - a)
        .map((issue): Operation => ({ kind: "close", issue })),
    ]
  }

  if (numbers.length === 0) return [{ kind: "ensure-label" }, { kind: "create" }]
  const canonical = numbers.at(0)
  if (canonical === undefined) return [{ kind: "ensure-label" }, { kind: "create" }]
  return [
    { kind: "update", issue: canonical },
    ...numbers.slice(1).flatMap((issue): Operation[] => [
      { kind: "duplicate-comment", issue, canonical },
      { kind: "close", issue },
    ]),
  ]
}

export function buildIssueBody(
  priorBody: string | undefined,
  decision: Decision,
  serverUrl: string,
  repository: string,
  now: Date,
): string {
  if (decision.state === "ignored") throw new Error("ignored decisions do not have issue bodies")
  const parsed = parseStoredState(priorBody)
  const state = parsed.value
  if (decision.state === "red") state.redCount += 1
  const runUrl = decision.run ? makeRunUrl(serverUrl, repository, decision.run.id) : "none"
  state.history = [
    ...state.history,
    {
      at: validIso(now.toISOString(), "history timestamp"),
      state: decision.state,
      reason: sanitizeCodeSpan(decision.reason),
      runId: decision.run?.id ?? null,
    },
  ].slice(-MAX_HISTORY)

  const corruption = parsed.corrupt
    ? "\n> Prior alert state was corrupt. Counters restarted from this observation.\n"
    : ""
  const rows = state.history
    .map(
      (row) =>
        `| \`${sanitizeCodeSpan(row.at)}\` | \`${row.state}\` | \`${sanitizeCodeSpan(row.reason)}\` | ${
          row.runId === null ? "none" : `[run](${makeRunUrl(serverUrl, repository, row.runId)})`
        } |`,
    )
    .join("\n")
  const encodedState = Buffer.from(JSON.stringify(state), "utf8").toString("base64url")

  return `${ALERT_MARKER}
${STATE_PREFIX}${encodedState} -->
# Android device CI needs attention

Current state: **${decision.state}**

Reason: \`${sanitizeCodeSpan(decision.reason)}\`

Run: ${runUrl === "none" ? "none" : `[${decision.run?.id}](${runUrl})`}

Red observations: **${state.redCount}**
${corruption}
## Recent observations

| UTC time | State | Reason | Evidence |
| --- | --- | --- | --- |
${rows}

This issue is managed by the Android device alert workflow. Fix the runner or product failure, then let a successful full workflow run close this issue.
`
}

export function sanitizeCodeSpan(value: string): string {
  let safe = ""
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) safe += " "
    else if (character === "`") safe += "\u02cb"
    else if (character === "|") safe += "\u00a6"
    else if (character === "@") safe += "\uff20"
    else if (character === "<") safe += "\u2039"
    else if (character === ">") safe += "\u203a"
    else safe += character
  }
  return safe.replace(/\s+/g, " ").trim().slice(0, 240)
}

export function filterAlertIssues(payload: unknown): AlertIssue[] {
  if (!Array.isArray(payload)) throw new Error("issues must be an array")
  return payload.flatMap((raw) => {
    if (!isRecord(raw) || "pull_request" in raw) return []
    const number = positiveInteger(raw.number, "issue.number")
    const body = typeof raw.body === "string" ? raw.body : ""
    if (!body.includes(ALERT_MARKER)) return []
    return [{ number, body }]
  })
}

export async function runAlert(
  config: AlertConfig,
  fetchImpl: FetchLike = fetch,
  now = new Date(),
): Promise<{ decision: Decision; operations: Operation[]; api: GitHubApi }> {
  validateRepository(config.repository)
  const serverUrl = validateServerUrl(config.serverUrl)
  const event = JSON.parse(await readFile(config.eventPath, "utf8"))
  const dryRun = config.dryRun || config.eventName === "workflow_dispatch"
  const api = new GitHubApi(config.token, fetchImpl, dryRun)
  const decision = await determineDecision(api, config.repository, config.eventName, event, now)
  if (decision.state === "ignored") return { decision, operations: [], api }

  let issues = await loadAlertIssues(api, config.repository)
  let operations = planTransition(decision, issues)

  if (decision.state === "red" && issues.length === 0) {
    await ensureLabel(api, config.repository)
    if (!config.dryRun) {
      issues = await loadAlertIssues(api, config.repository)
      operations = planTransition(decision, issues)
    }
  }

  for (const operation of operations) {
    if (operation.kind === "ensure-label") continue
    if (operation.kind === "create") {
      await api.request("POST", `/repos/${config.repository}/issues`, {
        title: "Android device CI needs attention",
        body: buildIssueBody(undefined, decision, serverUrl, config.repository, now),
        labels: [ALERT_LABEL],
      })
      continue
    }
    const issue = issues.find((candidate) => candidate.number === operation.issue)
    if (operation.kind === "update") {
      await api.request("PATCH", `/repos/${config.repository}/issues/${operation.issue}`, {
        body: buildIssueBody(issue?.body, decision, serverUrl, config.repository, now),
      })
    } else if (operation.kind === "recover-comment") {
      const runUrl = decision.run
        ? makeRunUrl(serverUrl, config.repository, decision.run.id)
        : `${serverUrl}/${config.repository}/actions/workflows/${ANDROID_WORKFLOW}`
      const commentPath = `/repos/${config.repository}/issues/${operation.issue}/comments`
      if (!(await hasRecoveryComment(api, commentPath))) {
        await api.request("POST", commentPath, {
          body: `${RECOVERY_MARKER}\nRecovered: the Android device workflow is green again. ${runUrl}`,
        })
      }
    } else if (operation.kind === "duplicate-comment") {
      await api.request("POST", `/repos/${config.repository}/issues/${operation.issue}/comments`, {
        body: `${DUPLICATE_MARKER}\nDuplicate alert. Canonical issue: #${operation.canonical}.`,
      })
    } else if (operation.kind === "close") {
      await api.request("PATCH", `/repos/${config.repository}/issues/${operation.issue}`, {
        state: "closed",
      })
    }
  }

  return { decision, operations, api }
}

async function ensureLabel(api: GitHubApi, repository: string): Promise<void> {
  try {
    await api.request("POST", `/repos/${repository}/labels`, {
      name: ALERT_LABEL,
      color: "B60205",
      description: "Managed alert for Android device CI failure or staleness",
    })
  } catch (error) {
    if (!isApiStatus(error, 422)) throw error
  }
}

async function loadAlertIssues(api: GitHubApi, repository: string): Promise<AlertIssue[]> {
  const payload = await api.request(
    "GET",
    `/repos/${repository}/issues?state=open&labels=${ALERT_LABEL}&per_page=100`,
  )
  return filterAlertIssues(payload)
}

function parseStoredState(body: string | undefined): ParsedState {
  const empty: StoredState = { version: 1, redCount: 0, history: [] }
  if (body === undefined) return { value: empty, corrupt: false }
  const start = body.indexOf(STATE_PREFIX)
  if (start < 0) return { value: empty, corrupt: true }
  const end = body.indexOf(" -->", start)
  if (end < 0) return { value: empty, corrupt: true }
  try {
    const encoded = body.slice(start + STATE_PREFIX.length, end)
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("bad state encoding")
    const decoded = Buffer.from(encoded, "base64url")
    if (decoded.toString("base64url") !== encoded) throw new Error("noncanonical state encoding")
    const parsed: unknown = JSON.parse(decoded.toString("utf8"))
    if (!isRecord(parsed) || parsed.version !== 1) throw new Error("bad version")
    const redCount = nonnegativeInteger(parsed.redCount, "redCount")
    if (!Array.isArray(parsed.history)) throw new Error("bad history")
    const history = parsed.history.slice(-MAX_HISTORY).map(parseHistoryRow)
    return { value: { version: 1, redCount, history }, corrupt: false }
  } catch {
    return { value: empty, corrupt: true }
  }
}

async function hasRecoveryComment(api: GitHubApi, commentPath: string): Promise<boolean> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const payload = await api.request("GET", `${commentPath}?per_page=100&page=${page}`)
    if (!Array.isArray(payload)) throw new Error("issue comments must be an array")
    const comments = payload.map(parseIssueComment)
    if (
      comments.some(
        (comment) =>
          comment.author === "github-actions[bot]" && comment.body.includes(RECOVERY_MARKER),
      )
    ) {
      return true
    }
    if (comments.length < 100) return false
  }
  throw new Error(`issue comments exceeded the ${MAX_COMMENT_PAGES}-page lookup limit`)
}

function parseIssueComment(raw: unknown): { author: string; body: string } {
  if (!isRecord(raw)) throw new Error("issue comment must be an object")
  const user = recordValue(raw.user, "issue comment user")
  return {
    author: stringField(user, "login"),
    body: stringField(raw, "body"),
  }
}

function parseHistoryRow(raw: unknown): HistoryRow {
  if (!isRecord(raw)) throw new Error("history row must be an object")
  const state = raw.state
  if (state !== "red" && state !== "green") throw new Error("bad history state")
  if (
    typeof raw.reason !== "string" ||
    raw.reason.length > 240 ||
    (raw.runId !== null && !Number.isSafeInteger(raw.runId))
  ) {
    throw new Error("bad history text")
  }
  return {
    at: validIso(raw.at, "history.at"),
    state,
    reason: raw.reason,
    runId: raw.runId === null ? null : positiveInteger(raw.runId, "history.runId"),
  }
}

function parseRuns(payload: unknown): WorkflowRun[] {
  const rawRuns = objectField(payload, "workflow_runs")
  if (!Array.isArray(rawRuns)) throw new Error("workflow_runs must be an array")
  return rawRuns.map(parseRun)
}

function parseRun(raw: unknown): WorkflowRun {
  if (!isRecord(raw)) throw new Error("workflow run must be an object")
  const status = stringField(raw, "status")
  if (
    !new Set(["queued", "in_progress", "completed", "pending", "waiting", "requested"]).has(status)
  ) {
    throw new Error("workflow run status is invalid")
  }
  const conclusion = raw.conclusion
  if (conclusion !== null && (typeof conclusion !== "string" || !conclusions.has(conclusion))) {
    throw new Error("workflow run conclusion is invalid")
  }
  const headSha = stringField(raw, "head_sha")
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("workflow run head_sha is invalid")
  const headBranch = stringField(raw, "head_branch")
  return {
    id: positiveInteger(raw.id, "workflow run id"),
    event: stringField(raw, "event"),
    path: stringField(raw, "path"),
    status,
    conclusion,
    headBranch,
    headSha,
    createdAt: validIso(raw.created_at, "workflow run created_at"),
    updatedAt: validIso(raw.updated_at, "workflow run updated_at"),
  }
}

function parseJobs(payload: unknown): Array<{ durationMs: number }> {
  const jobs = objectField(payload, "jobs")
  if (!Array.isArray(jobs)) throw new Error("jobs must be an array")
  return jobs.flatMap((raw) => {
    if (!isRecord(raw)) throw new Error("job must be an object")
    positiveInteger(raw.id, "job id")
    if (raw.started_at === null || raw.completed_at === null) return []
    const started = validIso(raw.started_at, "job started_at")
    const completed = validIso(raw.completed_at, "job completed_at")
    return [{ durationMs: Math.max(0, dateMs(completed) - dateMs(started)) }]
  })
}

function red(reason: string, run?: WorkflowRun): Decision {
  return run ? { state: "red", reason, run } : { state: "red", reason }
}

function green(reason: string, run?: WorkflowRun): Decision {
  return run ? { state: "green", reason, run } : { state: "green", reason }
}

function ignored(reason: string): Decision {
  return { state: "ignored", reason }
}

function makeRunUrl(serverUrl: string, repository: string, id: number): string {
  return `${validateServerUrl(serverUrl)}/${repository}/actions/runs/${positiveInteger(id, "run id")}`
}

function validateRepository(value: string): void {
  if (value !== EXPECTED_REPOSITORY) throw new Error("repository is invalid")
}

function validateServerUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("server URL is invalid")
  }
  return url.toString().replace(/\/$/, "")
}

function validIso(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error(`${name} must be an ISO timestamp`)
  }
  const parsed = new Date(value)
  const normalized = value.includes(".") ? value : value.replace(/Z$/, ".000Z")
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error(`${name} must be a valid ISO timestamp`)
  }
  return value
}

function dateMs(value: string): number {
  return new Date(value).getTime()
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`${name} must be positive`)
  return value as number
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${name} must be nonnegative`)
  return value as number
}

function objectField(value: unknown, key: string): unknown {
  if (!isRecord(value) || !(key in value)) throw new Error(`${key} is missing`)
  return value[key]
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
  return value
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string") throw new Error(`${key} must be a string`)
  return field
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isApiStatus(error: unknown, status: number): boolean {
  return isRecord(error) && error.status === status
}

function configFromEnvironment(): AlertConfig {
  const required = (name: string): string => {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  return {
    token: required("GITHUB_TOKEN"),
    repository: required("GITHUB_REPOSITORY"),
    serverUrl: required("GITHUB_SERVER_URL"),
    eventName: required("GITHUB_EVENT_NAME"),
    eventPath: required("GITHUB_EVENT_PATH"),
    dryRun: process.env.ALERT_DRY_RUN === "true",
  }
}

if (import.meta.main) {
  try {
    const result = await runAlert(configFromEnvironment())
    console.log(
      JSON.stringify({
        dryRun: process.env.ALERT_DRY_RUN === "true",
        state: result.decision.state,
        reason: result.decision.reason,
        operations: result.operations,
      }),
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unknown alert error")
    process.exit(1)
  }
}
