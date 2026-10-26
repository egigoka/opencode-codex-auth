export const Notifications = {
  id: "opencode-codex-auth",
  methods: {},
  events: {
    toast: {
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string" },
          duration: { type: "number" }
        },
        required: ["message"],
        additionalProperties: false
      }
    }
  }
}

export async function notificationClient(ctx) {
  const registration = await ctx.rpc.register(Notifications, {})
  return {
    showToast: async ({ body }) => {
      const { title, message, variant, duration } = body
      await registration.events.emit("toast", {
        ...(title ? { title } : {}),
        message,
        ...(variant ? { variant } : {}),
        ...(duration ? { duration } : {})
      })
    }
  }
}
