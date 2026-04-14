import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { qqChannel } from "./src/channel.js";
import { setQQRuntime } from "./src/runtime.js";
import { createQQSendMessageTool, createQQGetContextTool, createQQForwardMessageTool } from "./src/tools.js";

const plugin = {
  id: "qq",
  name: "QQ (OneBot)",
  description: "QQ channel plugin via OneBot v11",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQRuntime(api.runtime);
    api.registerChannel({ plugin: qqChannel });

    // 注册主动能力 Tool —— 让 Agent 可以主动发消息、查上下文、转发消息
    api.registerTool((ctx) => createQQSendMessageTool(ctx), { name: "qq_send_message" });
    api.registerTool((ctx) => createQQGetContextTool(ctx), { name: "qq_get_context" });
    api.registerTool((ctx) => createQQForwardMessageTool(ctx), { name: "qq_forward_message" });
  },
};

export default plugin;
