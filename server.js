import { notificationClient } from "./v2/notifications.js"
import { OpenAIMultiAuthPlugin } from "./dist/index.js"
import { createRotationProxy } from "./v2/proxy.js"

export async function oauthCredential(result, methodID) {
  if (result.type !== "success") throw new Error("OpenAI authorization failed")
  return { type: "oauth", methodID, access: result.access, refresh: result.refresh, expires: result.expires }
}

function parseIndexFromPrompt(text, fallback) {
  const match = String(text ?? "").match(/\d+/)
  const parsed = match ? Number.parseInt(match[0], 10) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback
}

export function commandArgsForTool(name, promptText) {
  const text = String(promptText ?? "").replace(/^\/?[\w-]+/, "").trim()
  if (name === "codex-switch-accounts" || name === "codex-toggle-account") {
    return { index: parseIndexFromPrompt(text, 1) }
  }
  if (name === "codex-remove-account") {
    return { index: parseIndexFromPrompt(text, 1), confirm: /confirm/.test(text) }
  }
  return {}
}

export function createV1EventForwarder(hooks) {
  return async (event) => {
    const type = event?.type
    if (type !== "session.deleted" && type !== "session.execution.interrupted") return
    const sessionID = event?.data?.sessionID
    if (typeof sessionID !== "string" || !sessionID) return
    try {
      await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: sessionID } } } })
    } catch {
      // best-effort session cleanup
    }
  }
}

const TOOL_SCHEMAS = {
  "codex-status": {
    input: { type: "object", properties: {}, additionalProperties: false },
    parse: () => ({})
  },
  "codex-switch-accounts": {
    input: {
      type: "object",
      properties: { index: { type: "number" } },
      required: ["index"],
      additionalProperties: false
    },
    parse: (input) => ({ index: input.index })
  },
  "codex-toggle-account": {
    input: {
      type: "object",
      properties: { index: { type: "number" } },
      required: ["index"],
      additionalProperties: false
    },
    parse: (input) => ({ index: input.index })
  },
  "codex-remove-account": {
    input: {
      type: "object",
      properties: { index: { type: "number" }, confirm: { type: "boolean" } },
      required: ["index"],
      additionalProperties: false
    },
    parse: (input) => ({ index: input.index, confirm: input.confirm })
  },
  "create-personality": {
    input: {
      type: "object",
      properties: {
        name: { type: "string" },
        sourceText: { type: "string" },
        targetStyle: { type: "string" },
        voiceFidelity: { type: "number" },
        competenceStrictness: { type: "number" },
        domain: { type: "string" },
        inspiration: { type: "string" },
        tone: { type: "string" },
        collaborationStyle: { type: "string" },
        codeStyle: { type: "string" },
        constraints: { type: "string" },
        examples: { type: "string" },
        scope: { type: "string" },
        overwrite: { type: "boolean" }
      },
      additionalProperties: false
    },
    parse: (input) => ({ ...input })
  }
}

export default {
  id: "opencode-codex-auth",
  async setup(ctx) {
    const tui = await notificationClient(ctx)
    const directory = ctx.location.directory
    const hooks = await OpenAIMultiAuthPlugin({
      directory,
      worktree: directory,
      client: {
        tui,
        session: { get: async ({ path }) => ({ data: await ctx.session.get({ sessionID: path.id }) }) }
      }
    })
    const getAuth = async () => {
      const connection = await ctx.integration.connection.active("openai")
      return connection ? await ctx.integration.connection.resolve(connection) : undefined
    }
    let transport
    let credentialKey
    const proxy = await createRotationProxy(async (url, init) => {
      const credential = await getAuth()
      if (credential?.type !== "oauth") return new Response("OpenAI OAuth connection required", { status: 401 })
      if (!transport || credentialKey !== credential.refresh) {
        transport = await hooks.auth.loader(async () => credential, {})
        credentialKey = credential.refresh
      }
      return transport.fetch(url, init)
    })
    const forwardV1Event = createV1EventForwarder(hooks)
    try {
      await ctx.provider.transform((editor) => {
        const record = editor.get("openai")
        for (const id of record?.models.keys() ?? []) {
          editor.models.update("openai", id, (model) => {
            model.settings = { ...model.settings, transport: "http", encoding: "none" }
          })
        }
        editor.update("openai", (provider) => {
          provider.settings = { ...provider.settings, transport: "http", encoding: "none" }
        })
      })
      await ctx.session.hook(
        "http.request",
        async (event) => {
          const credential = await getAuth()
          if (credential?.type !== "oauth") return
          const request = event.request
          const url = new URL(request.url)
          if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return
          const body = JSON.parse(await request.clone().text())
          body.prompt_cache_key ||= event.sessionID
          const headers = new Headers(request.headers)
          headers.delete("authorization")
          headers.delete("chatgpt-account-id")
          headers.delete("content-length")
          headers.delete("x-opencode-rotation")
          headers.set("x-opencode-rotation", proxy.secret)
          headers.set("session-id", event.sessionID)
          headers.set("session_id", event.sessionID)
          if (!headers.get("originator")) headers.set("originator", "opencode")
          event.request = new Request(proxy.url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: request.signal
          })
        },
        { providerID: "openai" }
      )
      await ctx.integration.transform((editor) => {
        hooks.auth.methods
          .filter((method) => method.type === "oauth" && method.label !== "Manage accounts")
          .forEach((method, index) => {
            const id = `codex-auth-${index}`
            editor.method.update({
              integrationID: "openai",
              method: {
                id,
                type: "oauth",
                label: method.label,
                authorize: async () => {
                  const flow = await method.authorize()
                  const credential = await oauthCredential(await flow.callback(), id)
                  return {
                    url: flow.url,
                    instructions: flow.instructions,
                    mode: flow.method,
                    callback: credential
                  }
                }
              }
            })
          })
      })
      await ctx.tool.transform((editor) => {
        for (const [name, tool] of Object.entries(hooks.tool)) {
          const schema = TOOL_SCHEMAS[name]
          if (!schema) continue
          editor.add({
            name,
            description: tool.description,
            input: schema.input,
            execute: async (input) => ({ content: await tool.execute(schema.parse(input ?? {})) })
          })
        }
      })
      await ctx.command.transform((editor) => {
        for (const [name, tool] of Object.entries(hooks.tool)) {
          if (!TOOL_SCHEMAS[name]) continue
          editor.add({
            name,
            description: tool.description,
            execute: async ({ sessionID, prompt }) => {
              const text = await tool.execute(commandArgsForTool(name, prompt.text))
              await ctx.session.synthetic({ sessionID, text, resume: false })
            }
          })
        }
      })
      const controller = new AbortController()
      const task = (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await forwardV1Event(event)
        }
      })().catch((error) => {
        if (!controller.signal.aborted) console.error("codex-auth event subscription failed", error)
      })
      return async () => {
        controller.abort()
        await task
        try {
          await hooks.dispose?.()
        } finally {
          await proxy.close()
        }
      }
    } catch (error) {
      await proxy.close()
      throw error
    }
  }
}
