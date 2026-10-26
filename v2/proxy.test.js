import test from "node:test"
import assert from "node:assert/strict"
import { createRotationProxy } from "./proxy.js"

test("proxy rejects untrusted requests and forwards only the fixed OAuth endpoint", async () => {
  let calls = 0
  const proxy = await createRotationProxy(async (url, init) => {
    calls++
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses")
    assert.equal(init.headers.get("authorization"), null)
    assert.equal(init.headers.get("x-opencode-rotation"), null)
    assert.equal(init.headers.get("session-id"), "session-test")
    assert.equal(init.headers.get("session_id"), "session-test")
    assert.equal(init.headers.get("originator"), "opencode")
    assert.equal(init.headers.get("x-opencode-selected-model-slug"), "gpt-5")
    assert.equal(init.headers.get("x-opencode-catalog-scope-key"), "identity:abc")
    assert.deepEqual(JSON.parse(init.body), { model: "test", stream: true })
    return new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  try {
    assert.equal((await fetch(proxy.url, { method: "POST" })).status, 403)
    assert.equal(
      (await fetch(`${proxy.url}/other`, { method: "POST", headers: { "x-opencode-rotation": proxy.secret } }))
        .status,
      404
    )
    const result = await fetch(proxy.url, {
      method: "POST",
      headers: {
        "x-opencode-rotation": proxy.secret,
        "session-id": "session-test",
        session_id: "session-test",
        originator: "opencode",
        authorization: "Bearer never-forward",
        "x-opencode-selected-model-slug": "gpt-5",
        "x-opencode-catalog-scope-key": "identity:abc"
      },
      body: JSON.stringify({ model: "test", stream: true })
    })
    assert.equal(await result.text(), "data: hello\n\n")
    assert.equal(calls, 1)
  } finally {
    await proxy.close()
  }
})
