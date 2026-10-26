import test from "node:test"
import assert from "node:assert/strict"
import { commandArgsForTool, createV1EventForwarder, isV2OAuthMethodExposed, oauthCredential } from "../server.js"

test("oauthCredential maps success results and rejects failures", async () => {
  assert.deepEqual(
    await oauthCredential({ type: "success", access: "a", refresh: "r", expires: 123 }, "codex-auth-0"),
    { type: "oauth", methodID: "codex-auth-0", access: "a", refresh: "r", expires: 123 }
  )
  await assert.rejects(oauthCredential({ type: "failed" }, "codex-auth-0"), /OpenAI authorization failed/)
})

test("command args parse account index and remove confirmation", () => {
  assert.deepEqual(commandArgsForTool("codex-switch-accounts", "codex-switch-accounts 2"), { index: 2 })
  assert.deepEqual(commandArgsForTool("codex-toggle-account", "/codex-toggle-account 3"), { index: 3 })
  assert.deepEqual(commandArgsForTool("codex-remove-account", "codex-remove-account 2 confirm"), {
    index: 2,
    confirm: true
  })
  assert.deepEqual(commandArgsForTool("codex-remove-account", "codex-remove-account 2"), {
    index: 2,
    confirm: false
  })
  assert.deepEqual(commandArgsForTool("codex-status", "codex-status"), {})
})

test("v2 hides Manage accounts oauth method", () => {
  const methods = [
    { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { type: "oauth", label: "Manage accounts" },
    { type: "api", label: "Manually enter API Key" }
  ]
  assert.deepEqual(methods.filter(isV2OAuthMethodExposed), [{ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }])
})

test("v1 event forwarder translates session deletion cleanup", async () => {
  const received = []
  const forward = createV1EventForwarder({ event: async (input) => void received.push(input) })
  await forward({ type: "session.execution.interrupted", data: { sessionID: "s1" } })
  await forward({ type: "session.step.started", data: { sessionID: "s1" } })
  await forward({ type: "session.deleted", data: {} })
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], {
    event: { type: "session.deleted", properties: { info: { id: "s1" } } }
  })
})
