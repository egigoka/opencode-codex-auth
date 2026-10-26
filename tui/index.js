import { Notifications } from "../v2/notifications.js"

export default {
  id: "opencode-codex-auth.notifications",
  setup(ctx) {
    return ctx.client.rpc(Notifications).events.on("toast", (event) => {
      const location = ctx.location ?? ctx.data.location.default()
      if (event.location.directory !== location.directory) return
      ctx.ui.toast.show(event.data)
    })
  }
}
