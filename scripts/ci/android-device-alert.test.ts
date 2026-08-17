import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ALERT_LABEL,
  ALERT_MARKER,
  type AlertIssue,
  ANDROID_WORKFLOW,
  buildIssueBody,
  COMPLETED_STALE_HOURS,
  classifyCompleted,
  type Decision,
  determineDecision,
  filterAlertIssues,
  GitHubApi,
  planTransition,
  runAlert,
  sanitizeCodeSpan,
  WORKFLOW_TIMEOUT_MINUTES,
  type WorkflowRun,
} from "./android-device-alert"

const directory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = join(directory, "..", "..")
const alertWorkflow = join(repositoryRoot, ".github", "workflows", "android-device-alert.yml")
const androidWorkflow = join(repositoryRoot, ".github", "workflows", "android-device.yml")
const cancellationFixture = join(directory, "fixtures", "android-cancelled-runs.json")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe.serial("Android workflow classification", () => {
  test("classifies success as green and hard failure conclusions as red", async () => {
    const api = new GitHubApi("test", routeFetch({}), false)
    expect(
      (await classifyCompleted(api, "owner/repo", parseRunForTest(run({ conclusion: "success" }))))
        .state,
    ).toBe("green")
    for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
      expect(
        (await classifyCompleted(api, "owner/repo", parseRunForTest(run({ conclusion })))).state,
      ).toBe("red")
    }
  })

  test("classifies all three measured 90m22s cancelled jobs as red", async () => {
    const fixture = JSON.parse(await readFile(cancellationFixture, "utf8"))
    for (const row of fixture.timeout) {
      const path = `/repos/owner/repo/actions/runs/${row.run}/jobs?filter=latest&per_page=100`
      const api = new GitHubApi("test", routeFetch({ [`GET ${path}`]: { jobs: [row.job] } }), false)
      const decision = await classifyCompleted(
        api,
        "owner/repo",
        parseRunForTest(run({ id: row.run, conclusion: "cancelled" })),
      )
      expect(decision.state).toBe("red")
      expect(decision.reason).toContain(`${WORKFLOW_TIMEOUT_MINUTES}-minute timeout`)
    }
  })

  test("ignores superseded zero-job and shorter human cancellations", async () => {
    const fixture = JSON.parse(await readFile(cancellationFixture, "utf8"))
    for (const row of [fixture.superseded, fixture.human]) {
      const path = `/repos/owner/repo/actions/runs/${row.run}/jobs?filter=latest&per_page=100`
      const api = new GitHubApi("test", routeFetch({ [`GET ${path}`]: { jobs: row.jobs } }), false)
      expect(
        (
          await classifyCompleted(
            api,
            "owner/repo",
            parseRunForTest(run({ id: row.run, conclusion: "cancelled" })),
          )
        ).state,
      ).toBe("ignored")
    }
  })

  test("ignores cancelled jobs that never started", async () => {
    const path = "/repos/owner/repo/actions/runs/62/jobs?filter=latest&per_page=100"
    const api = new GitHubApi(
      "test",
      routeFetch({
        [`GET ${path}`]: { jobs: [{ id: 6201, started_at: null, completed_at: null }] },
      }),
      false,
    )
    expect(
      (
        await classifyCompleted(
          api,
          "owner/repo",
          parseRunForTest(run({ id: 62, conclusion: "cancelled" })),
        )
      ).state,
    ).toBe("ignored")
  })

  test("uses the timeout in android-device.yml", async () => {
    const workflow = await readFile(androidWorkflow, "utf8")
    const match = workflow.match(/timeout-minutes:\s*(\d+)/)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(WORKFLOW_TIMEOUT_MINUTES)
  })

  test("ignores a workflow event when a newer completed run exists", async () => {
    const eventRun = run({ id: 10, created_at: "2026-08-01T00:00:00Z" })
    const newer = run({ id: 11, created_at: "2026-08-01T01:00:00Z" })
    const api = new GitHubApi(
      "test",
      routeFetch({
        "GET /repos/owner/repo/actions/runs/10": eventRun,
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&status=completed&per_page=20`]:
          {
            workflow_runs: [newer, eventRun],
          },
      }),
      false,
    )

    const decision = await determineDecision(api, "owner/repo", "workflow_run", {
      workflow_run: { id: 10 },
    })
    expect(decision.state).toBe("ignored")
    expect(decision.reason).toContain("newer completed")
  })

  test("marks a run active for over three hours red", async () => {
    const active = run({
      status: "in_progress",
      conclusion: null,
      created_at: "2026-08-01T00:00:00Z",
    })
    const api = scheduleApi([active])
    const decision = await determineDecision(
      api,
      "owner/repo",
      "schedule",
      {},
      new Date("2026-08-01T03:00:00Z"),
    )
    expect(decision.state).toBe("red")
  })

  test("marks an old success red only when main has a newer commit", async () => {
    const old = run({ updated_at: "2026-08-01T00:00:00Z" })
    for (const [sha, state] of [
      ["fedcba9876543210fedcba9876543210fedcba98", "red"],
      [old.head_sha, "green"],
    ] as const) {
      const routes = {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          {
            workflow_runs: [old],
          },
        "GET /repos/owner/repo/commits/main": { sha },
      }
      const decision = await determineDecision(
        new GitHubApi("test", routeFetch(routes), false),
        "owner/repo",
        "schedule",
        {},
        new Date(Date.parse(old.updated_at) + COMPLETED_STALE_HOURS * 60 * 60 * 1000 + 1),
      )
      expect(decision.state).toBe(state)
    }
  })

  test("rejects untrusted ids, conclusions, SHAs, and timestamps", async () => {
    const invalid = [
      run({ id: "1" }),
      run({ conclusion: "surprise" }),
      run({ head_sha: "main" }),
      run({ created_at: "yesterday" }),
      run({ created_at: "2026-02-31T00:00:00Z" }),
    ]
    for (const raw of invalid) {
      const api = new GitHubApi(
        "test",
        routeFetch({ "GET /repos/owner/repo/actions/runs/1": raw }),
        false,
      )
      await expect(
        determineDecision(api, "owner/repo", "workflow_run", { workflow_run: { id: 1 } }),
      ).rejects.toThrow()
    }
  })
})

describe.serial("alert planner", () => {
  const one: AlertIssue[] = [{ number: 7, body: ALERT_MARKER }]
  const many: AlertIssue[] = [
    { number: 9, body: ALERT_MARKER },
    { number: 3, body: ALERT_MARKER },
    { number: 7, body: ALERT_MARKER },
  ]

  test("covers every state transition row", () => {
    expect(planTransition(decision("green"), [])).toEqual([])
    expect(planTransition(decision("green"), one)).toEqual([
      { kind: "recover-comment", issue: 7 },
      { kind: "close", issue: 7 },
    ])
    expect(planTransition(decision("red"), [])).toEqual([
      { kind: "ensure-label" },
      { kind: "create" },
    ])
    expect(planTransition(decision("red"), one)).toEqual([{ kind: "update", issue: 7 }])
    expect(planTransition(decision("ignored"), many)).toEqual([])
  })

  test("keeps the lowest duplicate and closes recovery issues with the lowest last", () => {
    expect(planTransition(decision("red"), many)).toEqual([
      { kind: "update", issue: 3 },
      { kind: "duplicate-comment", issue: 7, canonical: 3 },
      { kind: "close", issue: 7 },
      { kind: "duplicate-comment", issue: 9, canonical: 3 },
      { kind: "close", issue: 9 },
    ])
    expect(planTransition(decision("green"), many)).toEqual([
      { kind: "recover-comment", issue: 3 },
      { kind: "close", issue: 9 },
      { kind: "close", issue: 7 },
      { kind: "close", issue: 3 },
    ])
  })
})

describe.serial("alert issue body and filtering", () => {
  test("ignores pull requests and same-label issues without the private marker", () => {
    expect(
      filterAlertIssues([
        { number: 1, body: ALERT_MARKER, pull_request: { url: "x" } },
        { number: 2, body: "ordinary issue" },
        { number: 3, body: ALERT_MARKER },
      ]),
    ).toEqual([{ number: 3, body: ALERT_MARKER }])
  })

  test("restarts corrupt state and says so", () => {
    const body = buildIssueBody(
      `${ALERT_MARKER}\n<!-- expo-turbo-android-device-alert-state:{bad} -->`,
      decision("red"),
      "https://github.com",
      "owner/repo",
      new Date("2026-08-01T00:00:00Z"),
    )
    expect(body).toContain("Prior alert state was corrupt")
    expect(body).toContain("Red observations: **1**")
  })

  test("keeps at most ten history rows", () => {
    let body: string | undefined
    for (let index = 0; index < 15; index += 1) {
      body = buildIssueBody(
        body,
        decision("red"),
        "https://github.com",
        "owner/repo",
        new Date(Date.UTC(2026, 7, 1, 0, index)),
      )
    }
    expect(body?.match(/^\| `2026-/gm)).toHaveLength(10)
    expect(body).toContain("Red observations: **15**")
  })

  test("sanitizes hostile free text into one bounded code span", () => {
    const hostile = ["line\n`break|table`\u0000\u0085   more", "x".repeat(500)].join("")
    const sanitized = sanitizeCodeSpan(hostile)
    expect(
      [...sanitized].every((character) => {
        const code = character.charCodeAt(0)
        return character !== "`" && character !== "|" && code > 0x1f && (code < 0x7f || code > 0x9f)
      }),
    ).toBe(true)
    expect(sanitized.length).toBeLessThanOrEqual(240)
    expect(sanitized).not.toContain("  ")
    const body = buildIssueBody(
      undefined,
      { state: "red", reason: hostile, run: parseRunForTest(run()) },
      "https://github.com",
      "owner/repo",
      new Date("2026-08-01T00:00:00Z"),
    )
    expect(typeof body).toBe("string")
  })
})

describe.serial("stub API integration", () => {
  test("dispatch dry-run performs no POST, PATCH, or DELETE request", async () => {
    const eventPath = await eventFile({})
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const fetcher = routeFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          {
            workflow_runs: [run({ conclusion: "failure" })],
          },
        [`GET /repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`]: [],
      },
      calls,
    )
    const result = await runAlert(config(eventPath, false, "workflow_dispatch"), fetcher)
    expect(result.decision.state).toBe("red")
    expect(calls.every((call) => call.method === "GET")).toBe(true)
    expect(result.api.writes.map((call) => call.method)).toEqual(["POST", "POST"])
  })

  test("creates the exact label and issue after re-fetching state", async () => {
    const eventPath = await eventFile({})
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const fetcher = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run({ conclusion: "failure" })] })],
        [`GET ${issuePath}`]: [response([]), response([])],
        "POST /repos/owner/repo/labels": [response({ name: ALERT_LABEL }, 201)],
        "POST /repos/owner/repo/issues": [response({ number: 4 }, 201)],
      },
      calls,
    )
    await runAlert(config(eventPath, false), fetcher)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`,
      `GET ${issuePath}`,
      "POST /repos/owner/repo/labels",
      `GET ${issuePath}`,
      "POST /repos/owner/repo/issues",
    ])
    expect(calls.at(-1)?.body).toMatchObject({
      title: "Android device CI needs attention",
      labels: [ALERT_LABEL],
    })
  })

  test("treats label-create 422 as idempotent", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const fetcher = queueFetch({
      [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
        [response({ workflow_runs: [run({ conclusion: "failure" })] })],
      [`GET ${issuePath}`]: [response([]), response([])],
      "POST /repos/owner/repo/labels": [response({ message: "already_exists" }, 422)],
      "POST /repos/owner/repo/issues": [response({ number: 4 }, 201)],
    })
    await expect(runAlert(config(eventPath, false), fetcher)).resolves.toBeDefined()
  })
})

describe.serial("alert workflow security shape", () => {
  test("has exact permissions, GitHub hosting, isolation, triggers, and pinned actions", async () => {
    const workflow = await readFile(alertWorkflow, "utf8")
    const permissions = workflow.match(/permissions:\n((?: {2}.+\n)+)\nconcurrency:/)?.[1]
    expect(permissions).toBe("  actions: read\n  contents: read\n  issues: write\n")
    expect(workflow).toContain("workflow_run:")
    expect(workflow).toContain("schedule:")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("runs-on: ubuntu-latest")
    expect(workflow).not.toContain("self-hosted")
    expect(workflow).not.toMatch(/^\s+needs:/m)
    expect(workflow.match(/^concurrency:/gm)).toHaveLength(1)
    for (const use of workflow.matchAll(/uses:\s*([^\s]+)/g)) {
      expect(use[1]).toMatch(/@[0-9a-f]{40}$/)
    }
    for (const runBlock of workflow.matchAll(/run:\s*(.+)/g)) {
      expect(runBlock[1]).not.toContain("${{")
    }
  })
})

function decision(state: Decision["state"]): Decision {
  return { state, reason: "fixed reason", run: parseRunForTest(run()) }
}

function parseRunForTest(raw: ReturnType<typeof run>): WorkflowRun {
  return {
    id: Number(raw.id),
    status: String(raw.status),
    conclusion: raw.conclusion === null ? null : String(raw.conclusion),
    headSha: String(raw.head_sha),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
  }
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T01:00:00Z",
    ...overrides,
  }
}

function scheduleApi(runs: unknown[]): GitHubApi {
  return new GitHubApi(
    "test",
    routeFetch({
      [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
        {
          workflow_runs: runs,
        },
    }),
    false,
  )
}

function config(eventPath: string, dryRun: boolean, eventName = "schedule") {
  return {
    token: "test",
    repository: "owner/repo",
    serverUrl: "https://github.com",
    eventName,
    eventPath,
    dryRun,
  }
}

async function eventFile(value: unknown): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "android-alert-event-"))
  fixtures.push(fixture)
  const path = join(fixture, "event.json")
  await writeFile(path, JSON.stringify(value))
  return path
}

function routeFetch(
  routes: Record<string, unknown>,
  calls: Array<{ method: string; path: string; body: unknown }> = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    )
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: `${url.pathname}${url.search}`, body })
    const key = `${method} ${url.pathname}${url.search}`
    if (!(key in routes)) throw new Error(`Unexpected request: ${key}`)
    return response(routes[key])
  }) as typeof fetch
}

function queueFetch(
  routes: Record<string, Response[]>,
  calls: Array<{ method: string; path: string; body: unknown }> = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    )
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: `${url.pathname}${url.search}`, body })
    const key = `${method} ${url.pathname}${url.search}`
    const next = routes[key]?.shift()
    if (!next) throw new Error(`Unexpected request: ${key}`)
    return next
  }) as typeof fetch
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
