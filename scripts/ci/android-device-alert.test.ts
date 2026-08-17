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
  RECOVERY_MARKER,
  runAlert,
  STATE_PREFIX,
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

  test("pins the cancelled timeout boundary to the workflow constant", async () => {
    const started = Date.parse("2026-08-01T00:00:00Z")
    for (const [offset, state] of [
      [WORKFLOW_TIMEOUT_MINUTES * 60 * 1000 - 1, "ignored"],
      [WORKFLOW_TIMEOUT_MINUTES * 60 * 1000, "red"],
      [WORKFLOW_TIMEOUT_MINUTES * 60 * 1000 + 1, "red"],
    ] as const) {
      const path = "/repos/owner/repo/actions/runs/63/jobs?filter=latest&per_page=100"
      const api = new GitHubApi(
        "test",
        routeFetch({
          [`GET ${path}`]: {
            jobs: [
              {
                id: 6301,
                started_at: new Date(started).toISOString(),
                completed_at: new Date(started + offset).toISOString(),
              },
            ],
          },
        }),
        false,
      )
      expect(
        (
          await classifyCompleted(
            api,
            "owner/repo",
            parseRunForTest(run({ id: 63, conclusion: "cancelled" })),
          )
        ).state,
      ).toBe(state)
    }
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

  test("uses the newest workflow_run event for red and green decisions", async () => {
    for (const [conclusion, state] of [
      ["failure", "red"],
      ["success", "green"],
    ] as const) {
      const eventRun = run({ id: 20, conclusion })
      const api = new GitHubApi(
        "test",
        routeFetch({
          "GET /repos/owner/repo/actions/runs/20": eventRun,
          [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&status=completed&per_page=20`]:
            { workflow_runs: [eventRun] },
        }),
        false,
      )
      const result = await determineDecision(api, "owner/repo", "workflow_run", {
        workflow_run: { id: 20 },
      })
      expect(result.state).toBe(state)
    }
  })

  test("ignores non-main workflow_run success and failure before classification", async () => {
    for (const conclusion of ["failure", "success"]) {
      const calls: Array<{ method: string; path: string; body: unknown }> = []
      const api = new GitHubApi(
        "test",
        routeFetch(
          {
            "GET /repos/owner/repo/actions/runs/21": run({
              id: 21,
              conclusion,
              head_branch: "scratch",
            }),
          },
          calls,
        ),
        false,
      )
      const result = await determineDecision(api, "owner/repo", "workflow_run", {
        workflow_run: { id: 21 },
      })
      expect(result.state).toBe("ignored")
      expect(result.reason).toContain("not from main")
      expect(calls).toHaveLength(1)
    }
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

  test("fails safe when an otherwise valid stale check receives a malformed main SHA", async () => {
    const old = run({ updated_at: "2026-08-01T00:00:00Z" })
    const routes = {
      [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
        {
          workflow_runs: [old],
        },
      "GET /repos/owner/repo/commits/main": { sha: "not-40-hex" },
    }

    await expect(
      determineDecision(
        new GitHubApi("test", routeFetch(routes), false),
        "owner/repo",
        "schedule",
        {},
        new Date(Date.parse(old.updated_at) + COMPLETED_STALE_HOURS * 60 * 60 * 1000 + 1),
      ),
    ).rejects.toThrow("main commit sha is invalid")
  })

  test("selects the newest scheduled run even when the API order is old first", async () => {
    const olderFailure = run({
      id: 40,
      conclusion: "failure",
      created_at: "2026-08-01T00:00:00Z",
    })
    const newerSuccess = run({
      id: 41,
      conclusion: "success",
      created_at: "2026-08-01T01:00:00Z",
      updated_at: "2026-08-01T02:00:00Z",
    })

    const result = await determineDecision(
      scheduleApi([olderFailure, newerSuccess]),
      "owner/repo",
      "schedule",
      {},
      new Date("2026-08-01T03:00:00Z"),
    )

    expect(result.state).toBe("green")
    expect(result.run?.id).toBe(41)
  })

  test("does not let old ignored conclusions bypass newer main commits", async () => {
    for (const conclusion of ["neutral", "skipped", "action_required", "stale", "cancelled"]) {
      const old = run({ id: 31, conclusion, updated_at: "2026-08-01T00:00:00Z" })
      const routes: Record<string, unknown> = {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          { workflow_runs: [old] },
        "GET /repos/owner/repo/commits/main": {
          sha: "fedcba9876543210fedcba9876543210fedcba98",
        },
      }
      if (conclusion === "cancelled") {
        routes["GET /repos/owner/repo/actions/runs/31/jobs?filter=latest&per_page=100"] = {
          jobs: [
            {
              id: 3101,
              started_at: "2026-08-01T00:00:00Z",
              completed_at: "2026-08-01T00:44:00Z",
            },
          ],
        }
      }
      const result = await determineDecision(
        new GitHubApi("test", routeFetch(routes), false),
        "owner/repo",
        "schedule",
        {},
        new Date("2026-08-02T00:00:00.001Z"),
      )
      expect(result.state).toBe("red")
      expect(result.reason).toContain("main has newer commits")
    }
  })

  test("keeps recent ignored conclusions ignored and handles no-run and API errors", async () => {
    const recent = run({ conclusion: "neutral", updated_at: "2026-08-01T12:00:00Z" })
    expect(
      (
        await determineDecision(
          scheduleApi([recent]),
          "owner/repo",
          "schedule",
          {},
          new Date("2026-08-02T00:00:00Z"),
        )
      ).state,
    ).toBe("ignored")
    expect((await determineDecision(scheduleApi([]), "owner/repo", "schedule", {})).state).toBe(
      "red",
    )
    await expect(
      determineDecision(new GitHubApi("test", routeFetch({}), false), "owner/repo", "schedule", {}),
    ).rejects.toThrow("Unexpected request")
  })

  test("rejects each untrusted workflow run field with its exact validation error", async () => {
    const invalid: Array<[Record<string, unknown>, string]> = [
      [{ id: "1" }, "workflow run id must be positive"],
      [{ status: "running" }, "workflow run status is invalid"],
      [{ conclusion: "surprise" }, "workflow run conclusion is invalid"],
      [{ head_sha: "main" }, "workflow run head_sha is invalid"],
      [{ head_sha: "A".repeat(40) }, "workflow run head_sha is invalid"],
      [
        { head_sha: "0123456789abcdef0123456789abcdef01234567x" },
        "workflow run head_sha is invalid",
      ],
      [{ head_branch: 7 }, "head_branch must be a string"],
      [{ created_at: "yesterday" }, "workflow run created_at must be an ISO timestamp"],
      [
        { created_at: "2026-02-31T00:00:00Z" },
        "workflow run created_at must be a valid ISO timestamp",
      ],
      [
        { created_at: "2026-08-01T00:00:00.0Z" },
        "workflow run created_at must be an ISO timestamp",
      ],
      [{ updated_at: "tomorrow" }, "workflow run updated_at must be an ISO timestamp"],
      [
        { updated_at: "2026-08-01T24:00:00Z" },
        "workflow run updated_at must be a valid ISO timestamp",
      ],
    ]
    for (const [overrides, message] of invalid) {
      const api = new GitHubApi(
        "test",
        routeFetch({ "GET /repos/owner/repo/actions/runs/1": run(overrides) }),
        false,
      )
      await expect(
        determineDecision(api, "owner/repo", "workflow_run", { workflow_run: { id: 1 } }),
      ).rejects.toThrow(message)
    }
  })

  test("accepts only canonical ISO seconds and milliseconds", async () => {
    for (const timestamp of ["2026-08-01T00:00:00Z", "2026-08-01T00:00:00.123Z"]) {
      const result = await determineDecision(
        scheduleApi([run({ created_at: timestamp, updated_at: timestamp })]),
        "owner/repo",
        "schedule",
        {},
        new Date("2026-08-01T01:00:00Z"),
      )
      expect(result.state).toBe("green")
      expect(result.run?.createdAt).toBe(timestamp)
      expect(result.run?.updatedAt).toBe(timestamp)
    }
  })

  test("rejects an untrusted event id before any request", async () => {
    let calls = 0
    const api = new GitHubApi(
      "test",
      (() => {
        calls += 1
        throw new Error("network must not run")
      }) as unknown as typeof fetch,
      false,
    )
    await expect(
      determineDecision(api, "owner/repo", "workflow_run", { workflow_run: { id: "1" } }),
    ).rejects.toThrow("workflow_run.id must be positive")
    expect(calls).toBe(0)
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
    expect(body).not.toContain("Recoveries:")
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
    const hostile = ["line\n`break|table` @team <!-- -->\u0000\u0085   more", "x".repeat(500)].join(
      "",
    )
    const sanitized = sanitizeCodeSpan(hostile)
    expect(
      [...sanitized].every((character) => {
        const code = character.charCodeAt(0)
        return !"`|@<>".includes(character) && code > 0x1f && (code < 0x7f || code > 0x9f)
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
    expect(body).not.toContain("@team")
    expect(body).not.toContain("<!-- -->")
    expect(body).not.toContain("`break")
    expect(body).not.toContain("|table")
  })

  test("strict state encoding contains hostile dash runs and rendered history stays safe", () => {
    const hostile = "three--- five----- seven------- --> @team `code` |row| <!--"
    const priorState = {
      version: 1,
      redCount: 4,
      history: [
        {
          at: "2026-08-01T00:00:00Z",
          state: "red",
          reason: hostile,
          runId: 1,
        },
      ],
    }
    const encoded = Buffer.from(JSON.stringify(priorState)).toString("base64url")
    const body = buildIssueBody(
      `${ALERT_MARKER}\n${STATE_PREFIX}${encoded} -->\nvisible`,
      decision("red"),
      "https://github.com",
      "owner/repo",
      new Date("2026-08-02T00:00:00Z"),
    )
    const stateLine = body.split("\n").find((line) => line.startsWith(STATE_PREFIX))
    expect(stateLine).toMatch(/^<!-- expo-turbo-android-device-alert-state:v2:[A-Za-z0-9_-]+ -->$/)
    expect(stateLine?.match(/-->/g)).toHaveLength(1)
    expect(body).not.toContain("@team")
    expect(body).not.toContain("`code`")
    expect(body).not.toContain("|row|")
    expect(body).not.toContain("<!--\n")
    expect(body).toContain("Red observations: **5**")
  })

  test("safely resets prior raw, corrupt, and noncanonical state bodies", () => {
    const bodies = [
      `${ALERT_MARKER}\n<!-- expo-turbo-android-device-alert-state:{"version":1} -->`,
      `${ALERT_MARKER}\n${STATE_PREFIX}bad*data -->`,
      `${ALERT_MARKER}\n${STATE_PREFIX}e30= -->`,
    ]
    for (const prior of bodies) {
      const body = buildIssueBody(
        prior,
        decision("red"),
        "https://github.com",
        "owner/repo",
        new Date("2026-08-01T00:00:00Z"),
      )
      expect(body).toContain("Prior alert state was corrupt")
      expect(body).toContain("Red observations: **1**")
    }
  })

  test("rejects valid state JSON that uses a non-base64url charset", () => {
    const state = { version: 1, redCount: 1, history: [], x: ">" }
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64url").replace("-", "+")
    const prior = `${ALERT_MARKER}\n${STATE_PREFIX}${encoded} -->`
    const body = buildIssueBody(
      prior,
      decision("red"),
      "https://github.com",
      "owner/repo",
      new Date("2026-08-01T00:00:00Z"),
    )

    expect(body).toContain("Prior alert state was corrupt")
    expect(body).toContain("Red observations: **1**")
  })

  test("the base64url charset guard is load-bearing", async () => {
    const state = { version: 1, redCount: 1, history: [], x: ">" }
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64url").replace("-", "+")
    const source = await readFile(join(directory, "android-device-alert.ts"), "utf8")
    const mutation = source.replace(
      '    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("bad state encoding")\n',
      "",
    )
    expect(mutation).not.toBe(source)
    const mutatedModule = await import(`file://${await writeAlertMutation(mutation)}?charset-guard`)
    const originalFrom = Buffer.from
    Buffer.from = ((value: string, encoding: string) => {
      if (value === encoded && encoding === "base64url") {
        const decoded = originalFrom(encoded.replace("+", "-"), "base64url")
        return {
          toString: (targetEncoding: string) =>
            targetEncoding === "base64url"
              ? encoded
              : decoded.toString(targetEncoding as BufferEncoding),
        } as unknown as Buffer
      }
      return originalFrom(value, encoding as BufferEncoding)
    }) as typeof Buffer.from
    let body: string
    try {
      body = mutatedModule.buildIssueBody(
        `${ALERT_MARKER}\n${STATE_PREFIX}${encoded} -->`,
        decision("red"),
        "https://github.com",
        "owner/repo",
        new Date("2026-08-01T00:00:00Z"),
      )
    } finally {
      Buffer.from = originalFrom
    }

    expect(body).not.toContain("Prior alert state was corrupt")
    expect(body).toContain("Red observations: **2**")
  })

  test("rejects padded standard-base64 state that otherwise has redCount 999", () => {
    const state = { version: 1, redCount: 999, history: [] }
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64")
    const body = buildIssueBody(
      `${ALERT_MARKER}\n${STATE_PREFIX}${encoded} -->`,
      decision("red"),
      "https://github.com",
      "owner/repo",
      new Date("2026-08-01T00:00:00Z"),
    )

    expect(body).toContain("Prior alert state was corrupt")
    expect(body).toContain("Red observations: **1**")
  })

  test("the base64url canonicality guard is load-bearing", async () => {
    const state = { version: 1, redCount: 999, history: [] }
    const canonical = Buffer.from(JSON.stringify(state)).toString("base64url")
    expect(canonical.endsWith("0")).toBe(true)
    const encoded = `${canonical.slice(0, -1)}1`
    const source = await readFile(join(directory, "android-device-alert.ts"), "utf8")
    const mutation = source.replace(
      '    if (decoded.toString("base64url") !== encoded) throw new Error("noncanonical state encoding")\n',
      "",
    )
    expect(mutation).not.toBe(source)
    const mutatedModule = await import(
      `file://${await writeAlertMutation(mutation)}?canonicality-guard`
    )
    const body = mutatedModule.buildIssueBody(
      `${ALERT_MARKER}\n${STATE_PREFIX}${encoded} -->`,
      decision("red"),
      "https://github.com",
      "owner/repo",
      new Date("2026-08-01T00:00:00Z"),
    )

    expect(body).not.toContain("Prior alert state was corrupt")
    expect(body).toContain("Red observations: **1000**")
  })

  test("rejects a stored reason above the 240-character bound", () => {
    const priorState = {
      version: 1,
      redCount: 4,
      history: [
        {
          at: "2026-08-01T00:00:00Z",
          state: "red",
          reason: "x".repeat(241),
          runId: 1,
        },
      ],
    }
    const encoded = Buffer.from(JSON.stringify(priorState)).toString("base64url")
    const body = buildIssueBody(
      `${ALERT_MARKER}\n${STATE_PREFIX}${encoded} -->`,
      decision("red"),
      "https://github.com",
      "owner/repo",
      new Date("2026-08-02T00:00:00Z"),
    )

    expect(body).toContain("Prior alert state was corrupt")
    expect(body).toContain("Red observations: **1**")
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
    await runAlert(config(eventPath, false), fetcher, new Date("2026-08-01T02:00:00Z"))
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

  test("updates an existing red issue with the new managed body", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const fetcher = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run({ conclusion: "failure" })] })],
        [`GET ${issuePath}`]: [response([{ number: 3, body: ALERT_MARKER }])],
        "PATCH /repos/owner/repo/issues/3": [response({ number: 3 })],
      },
      calls,
    )

    await runAlert(config(eventPath, false), fetcher, new Date("2026-08-01T02:00:00Z"))

    const patchCall = calls.find((call) => call.method === "PATCH")
    if (!patchCall) throw new Error("missing red issue update")
    expect(patchCall.body).toEqual({
      body: expect.stringContaining("The Android workflow concluded failure."),
    })
    expect((patchCall.body as { body?: string }).body).toContain(ALERT_MARKER)
    expect((patchCall.body as { body?: string }).body).toContain("Red observations: **1**")
  })

  test("rejects insecure or credentialed server URLs before any network request", async () => {
    const eventPath = await eventFile({})
    for (const serverUrl of ["http://github.com", "https://user:pass@github.com"]) {
      let calls = 0
      const fetcher = (() => {
        calls += 1
        throw new Error("network must not run")
      }) as unknown as typeof fetch
      await expect(runAlert({ ...config(eventPath, false), serverUrl }, fetcher)).rejects.toThrow(
        "server URL is invalid",
      )
      expect(calls).toBe(0)
    }
  })

  test("rejects malformed GITHUB_REPOSITORY before any network request", async () => {
    const eventPath = await eventFile({})
    let calls = 0
    const fetcher = (() => {
      calls += 1
      throw new Error("network must not run")
    }) as unknown as typeof fetch

    await expect(
      runAlert({ ...config(eventPath, false), repository: "owner/repo/extra" }, fetcher),
    ).rejects.toThrow("repository is invalid")
    expect(calls).toBe(0)
  })

  test("does not repeat recovery after a close failure, then retries closes in final order", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const commentsPath = "/repos/owner/repo/issues/3/comments"
    const issues = [3, 7, 9].map((number) => ({ number, body: ALERT_MARKER }))
    const firstCalls: Array<{ method: string; path: string; body: unknown }> = []
    const first = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run()] })],
        [`GET ${issuePath}`]: [response(issues)],
        [`GET ${commentsPath}?per_page=100&page=1`]: [response([])],
        [`POST ${commentsPath}`]: [response({ id: 1 }, 201)],
        "PATCH /repos/owner/repo/issues/9": [response({ message: "failed" }, 500)],
      },
      firstCalls,
    )
    await expect(
      runAlert(config(eventPath, false), first, new Date("2026-08-01T02:00:00Z")),
    ).rejects.toThrow("returned 500")
    expect(firstCalls.filter((call) => call.method === "POST")).toHaveLength(1)
    const recoveryWrite = firstCalls.find((call) => call.method === "POST")
    expect(recoveryWrite).toBeDefined()
    if (!recoveryWrite) throw new Error("missing recovery write")
    expect((recoveryWrite.body as { body: string }).body).toContain(RECOVERY_MARKER)

    const retryCalls: Array<{ method: string; path: string; body: unknown }> = []
    const retry = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run()] })],
        [`GET ${issuePath}`]: [response(issues)],
        [`GET ${commentsPath}?per_page=100&page=1`]: [
          response([comment(`${RECOVERY_MARKER}\nRecovered`)]),
        ],
        "PATCH /repos/owner/repo/issues/9": [response({ state: "closed" })],
        "PATCH /repos/owner/repo/issues/7": [response({ state: "closed" })],
        "PATCH /repos/owner/repo/issues/3": [response({ state: "closed" })],
      },
      retryCalls,
    )
    await runAlert(config(eventPath, false), retry, new Date("2026-08-01T02:00:00Z"))
    expect(retryCalls.some((call) => call.method === "POST")).toBe(false)
    expect(retryCalls.filter((call) => call.method === "PATCH").map((call) => call.path)).toEqual([
      "/repos/owner/repo/issues/9",
      "/repos/owner/repo/issues/7",
      "/repos/owner/repo/issues/3",
    ])
    expect(retryCalls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
      { state: "closed" },
      { state: "closed" },
      { state: "closed" },
    ])
  })

  test("does not close an issue when its recovery comment fails", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const fetcher = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run()] })],
        [`GET ${issuePath}`]: [response([{ number: 3, body: ALERT_MARKER }])],
        "GET /repos/owner/repo/issues/3/comments?per_page=100&page=1": [response([])],
        "POST /repos/owner/repo/issues/3/comments": [response({ message: "failed" }, 500)],
      },
      calls,
    )
    await expect(
      runAlert(config(eventPath, false), fetcher, new Date("2026-08-01T02:00:00Z")),
    ).rejects.toThrow("returned 500")
    expect(calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  test("ignores a spoofed marker and finds the bot marker after page one", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const commentsPath = "/repos/owner/repo/issues/3/comments"
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const firstPage = [
      comment(RECOVERY_MARKER, "spoofing-user"),
      ...Array.from({ length: 99 }, (_, index) => comment(`ordinary ${index}`, `user-${index}`)),
    ]
    const fetcher = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run()] })],
        [`GET ${issuePath}`]: [response([{ number: 3, body: ALERT_MARKER }])],
        [`GET ${commentsPath}?per_page=100&page=1`]: [response(firstPage)],
        [`GET ${commentsPath}?per_page=100&page=2`]: [
          response([comment(RECOVERY_MARKER, "github-actions[bot]")]),
        ],
        "PATCH /repos/owner/repo/issues/3": [response({ state: "closed" })],
      },
      calls,
    )

    await runAlert(config(eventPath, false), fetcher, new Date("2026-08-01T02:00:00Z"))

    expect(calls.filter((call) => call.method === "GET").map((call) => call.path)).toContain(
      `${commentsPath}?per_page=100&page=2`,
    )
    expect(calls.some((call) => call.method === "POST")).toBe(false)
    expect(calls.at(-1)?.body).toEqual({ state: "closed" })
  })

  test("posts one recovery after all comment pages prove no bot marker", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const commentsPath = "/repos/owner/repo/issues/3/comments"
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const fetcher = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run()] })],
        [`GET ${issuePath}`]: [response([{ number: 3, body: ALERT_MARKER }])],
        [`GET ${commentsPath}?per_page=100&page=1`]: [
          response(Array.from({ length: 100 }, (_, index) => comment(`ordinary ${index}`))),
        ],
        [`GET ${commentsPath}?per_page=100&page=2`]: [response([])],
        [`POST ${commentsPath}`]: [response({ id: 501 }, 201)],
        "PATCH /repos/owner/repo/issues/3": [response({ state: "closed" })],
      },
      calls,
    )

    await runAlert(config(eventPath, false), fetcher, new Date("2026-08-01T02:00:00Z"))

    const posts = calls.filter((call) => call.method === "POST")
    expect(posts).toHaveLength(1)
    const post = posts[0]
    if (!post) throw new Error("missing recovery post")
    expect((post.body as { body: string }).body).toContain(RECOVERY_MARKER)
  })

  test("fails closed on a malformed later comment page", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const commentsPath = "/repos/owner/repo/issues/3/comments"
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const fetcher = queueFetch(
      {
        [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
          [response({ workflow_runs: [run()] })],
        [`GET ${issuePath}`]: [response([{ number: 3, body: ALERT_MARKER }])],
        [`GET ${commentsPath}?per_page=100&page=1`]: [
          response(Array.from({ length: 100 }, (_, index) => comment(`ordinary ${index}`))),
        ],
        [`GET ${commentsPath}?per_page=100&page=2`]: [response({ comments: [] })],
      },
      calls,
    )

    await expect(
      runAlert(config(eventPath, false), fetcher, new Date("2026-08-01T02:00:00Z")),
    ).rejects.toThrow("issue comments must be an array")
    expect(calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(false)
  })

  test("stops after ten full comment pages instead of assuming no marker", async () => {
    const eventPath = await eventFile({})
    const issuePath = `/repos/owner/repo/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
    const commentsPath = "/repos/owner/repo/issues/3/comments"
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const routes: Record<string, unknown> = {
      [`GET /repos/owner/repo/actions/workflows/${ANDROID_WORKFLOW}/runs?branch=main&per_page=20`]:
        {
          workflow_runs: [run()],
        },
      [`GET ${issuePath}`]: [{ number: 3, body: ALERT_MARKER }],
    }
    for (let page = 1; page <= 10; page += 1) {
      routes[`GET ${commentsPath}?per_page=100&page=${page}`] = Array.from(
        { length: 100 },
        (_, index) => comment(`page ${page} comment ${index}`),
      )
    }

    await expect(
      runAlert(
        config(eventPath, false),
        routeFetch(routes, calls),
        new Date("2026-08-01T02:00:00Z"),
      ),
    ).rejects.toThrow("issue comments exceeded the 10-page lookup limit")
    expect(calls.filter((call) => call.path.startsWith(commentsPath))).toHaveLength(10)
    expect(calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(false)
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
    headBranch: String(raw.head_branch),
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
    head_branch: "main",
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T01:00:00Z",
    ...overrides,
  }
}

function comment(body: string, login = "github-actions[bot]") {
  return { body, user: { login } }
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

async function writeAlertMutation(source: string): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "android-alert-mutation-"))
  fixtures.push(fixture)
  const path = join(fixture, "android-device-alert.ts")
  await writeFile(path, source)
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
