import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

// The native V2 driver owns fetch. A private loopback endpoint lets the existing
// rotation transport process responses without replacing the driver or protocol.
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "session-id",
  "session_id",
  "originator",
  "user-agent",
  "x-opencode-catalog-scope-key",
  "x-opencode-catalog-default-fields",
  "x-opencode-selected-model-slug",
  "x-opencode-ultra-state"
]

export async function createRotationProxy(forward) {
  const secret = randomBytes(32).toString("hex")
  const server = createServer(async (req, res) => {
    if (req.headers["x-opencode-rotation"] !== secret) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== "POST" || req.url !== "/responses") {
      res.writeHead(404).end()
      return
    }
    const controller = new AbortController()
    res.on("close", () => controller.abort())
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 32 * 1024 * 1024) {
          res.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      const headers = new Headers()
      for (const key of FORWARDED_HEADERS) {
        if (typeof req.headers[key] === "string") headers.set(key, req.headers[key])
      }
      // The legacy transport adds /codex and validates the final backend URL.
      const response = await forward("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        signal: controller.signal
      })
      // fetch has already decoded content encodings and owns transfer framing.
      for (const [name, value] of response.headers) {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) {
          res.setHeader(name, value)
        }
      }
      res.writeHead(response.status)
      if (response.body) await pipeline(Readable.fromWeb(response.body), res)
      else res.end()
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  server.unref()
  return {
    url: `http://127.0.0.1:${server.address().port}/responses`,
    secret,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  }
}
