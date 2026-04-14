/**
 * QQ 主动能力 Tool —— 让 Agent 可以主动发消息、查上下文、转发消息
 *
 * 安全约束：
 * - 所有 tool 仅在当前对话由 admins 白名单用户触发时可用
 * - 发送频率受限于 OneBotClient 本身的队列
 */

import {
  getRegisteredClient,
} from "./runtime.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// ─── JSON Schema 定义（不依赖 @sinclair/typebox）───────────

const QQSendMessageSchema = {
  type: "object" as const,
  properties: {
    target_type: {
      type: "string" as const,
      enum: ["group", "private"],
      description: "发送目标类型：group（群聊）或 private（私聊）",
    },
    target_id: {
      type: "number" as const,
      description: "目标 ID：群号或 QQ 号",
    },
    message: {
      type: "string" as const,
      description: "要发送的消息文本内容",
      maxLength: 4500,
    },
    forward: {
      type: "boolean" as const,
      description: "是否以合并转发形式发送（仅群聊有效）。长消息建议开启。默认 false",
    },
    forward_node_name: {
      type: "string" as const,
      description: "合并转发时显示的发送者昵称，默认 OpenClaw",
      maxLength: 20,
    },
  },
  required: ["target_type", "target_id", "message"],
  additionalProperties: false,
};

const QQGetContextSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["group_list", "friend_list", "group_history", "group_info", "get_message"],
      description:
        "操作类型：group_list（群列表）、friend_list（好友列表）、group_history（群消息历史）、group_info（群详情）、get_message（获取单条消息）",
    },
    group_id: {
      type: "number" as const,
      description: "群号（group_history 和 group_info 时必填）",
    },
    message_id: {
      type: "string" as const,
      description: "消息 ID（get_message 时必填）",
    },
  },
  required: ["action"],
  additionalProperties: false,
};

const QQForwardMessageSchema = {
  type: "object" as const,
  properties: {
    target_type: {
      type: "string" as const,
      enum: ["group", "private"],
      description: "转发目标类型",
    },
    target_id: {
      type: "number" as const,
      description: "转发目标 ID（群号或 QQ 号）",
    },
    messages: {
      type: "array" as const,
      description: "要合并转发的消息列表",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "转发节点显示的发送者昵称", maxLength: 20 },
          content: { type: "string" as const, description: "节点消息内容", maxLength: 4500 },
        },
        required: ["name", "content"],
      },
    },
  },
  required: ["target_type", "target_id", "messages"],
  additionalProperties: false,
};

// ─── 类型定义 ──────────────────────────────────────────────

interface QQSendMessageParams {
  target_type: "group" | "private";
  target_id: number;
  message: string;
  forward?: boolean;
  forward_node_name?: string;
}

interface QQGetContextParams {
  action: "group_list" | "friend_list" | "group_history" | "group_info" | "get_message";
  group_id?: number;
  message_id?: string;
}

interface QQForwardMessageParams {
  target_type: "group" | "private";
  target_id: number;
  messages: Array<{ name: string; content: string }>;
}

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 将 MEDIA: 前缀的文件路径转换为 base64 图片 URL。
 * NapCat 运行在远程 VPS，无法访问容器本地文件，
 * 因此需要将图片读取为 base64 再发送。
 * 如果内容不含 MEDIA: 前缀，原样返回文本。
 */
async function resolveMediaContent(content: string): Promise<string> {
  const mediaPrefix = "MEDIA:";
  if (!content.startsWith(mediaPrefix)) return content;

  const filePath = content.slice(mediaPrefix.length).trim();
  if (!filePath || !existsSync(filePath)) return content;

  try {
    const buffer = await readFile(filePath);
    const base64 = buffer.toString("base64");
    return `[CQ:image,file=base64://${base64}]`;
  } catch {
    // 如果读取失败，尝试 file:// 协议（仅在 NapCat 与容器同机时有效）
    return `[CQ:image,file=file://${filePath}]`;
  }
}

/**
 * 将 content 转换为合并转发节点的消息段数组格式。
 * OneBot 合并转发节点的 content 支持消息段数组，
 * 这比 CQ 码字符串兼容性更好。
 */
async function resolveForwardNodeContent(content: string): Promise<string | Array<{ type: string; data: Record<string, unknown> }>> {
  const mediaPrefix = "MEDIA:";
  if (!content.startsWith(mediaPrefix)) return content;

  const filePath = content.slice(mediaPrefix.length).trim();
  if (!filePath || !existsSync(filePath)) return content;

  try {
    const buffer = await readFile(filePath);
    const base64 = buffer.toString("base64");
    return [{ type: "image", data: { file: `base64://${base64}` } }];
  } catch {
    return content;
  }
}

function resolveClient(accountId?: string) {
  const client = getRegisteredClient(accountId);
  if (!client || !client.isConnected()) {
    return { client: null, error: "QQ 客户端未连接。请确认 QQ 频道已启动。" };
  }
  return { client, error: null };
}

function truncateForToolResponse(data: unknown, maxChars = 8000): string {
  const json = JSON.stringify(data, null, 2);
  if (json.length <= maxChars) return json;
  return json.slice(0, maxChars) + "\n... (已截断)";
}

// ─── Tool 工厂 ─────────────────────────────────────────────

export function createQQSendMessageTool(_ctx?: any) {
  return {
    name: "qq_send_message",
    label: "QQ 发送消息",
    description:
      "向 QQ 群或私聊主动发送消息。支持普通文本和合并转发形式。仅管理员可触发。",
    parameters: QQSendMessageSchema,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
    ) => {
      const params = rawParams as QQSendMessageParams;
      const { client, error } = resolveClient();
      if (!client) return { output: error };

      // 统一处理 MEDIA: 前缀（异步转 base64）
      const resolvedMessage = await resolveMediaContent(params.message);

      try {
        if (params.target_type === "group") {
          if (params.forward) {
            // 合并转发
            const nodeName = params.forward_node_name || "OpenClaw";
            const selfId = client.getSelfId();
            const nodeUin = selfId ? String(selfId) : "10000";
            const messages = [
              {
                type: "node",
                data: {
                  name: nodeName,
                  uin: nodeUin,
                  content: resolvedMessage,
                },
              },
            ];
            // 尝试 send_group_forward_msg，失败退回 send_forward_msg
            try {
              await (client as any).sendWithResponse(
                "send_group_forward_msg",
                { group_id: params.target_id, messages },
                15000,
              );
            } catch {
              await (client as any).sendWithResponse(
                "send_forward_msg",
                { group_id: params.target_id, messages },
                15000,
              );
            }
            return { output: `已向群 ${params.target_id} 发送合并转发消息` };
          }
          const ack = await client.sendGroupMsgAck(params.target_id, resolvedMessage);
          const msgId = ack?.message_id ?? "unknown";
          return { output: `已向群 ${params.target_id} 发送消息（message_id: ${msgId}）` };
        }

        // 私聊
        const ack = await client.sendPrivateMsgAck(params.target_id, resolvedMessage);
        const msgId = ack?.message_id ?? "unknown";
        return { output: `已向用户 ${params.target_id} 发送私聊消息（message_id: ${msgId}）` };
      } catch (err) {
        return { output: `发送失败：${String(err)}` };
      }
    },
  };
}

export function createQQGetContextTool(_ctx?: any) {
  return {
    name: "qq_get_context",
    label: "QQ 获取上下文",
    description:
      "获取 QQ 群列表、好友列表、群消息历史、群详情或单条消息内容。仅管理员可触发。",
    parameters: QQGetContextSchema,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
    ) => {
      const params = rawParams as QQGetContextParams;
      const { client, error } = resolveClient();
      if (!client) return { output: error };

      try {
        switch (params.action) {
          case "group_list": {
            const groups = await client.getGroupList();
            return {
              output: `获取到 ${groups.length} 个群：\n${truncateForToolResponse(groups)}`,
            };
          }
          case "friend_list": {
            const friends = await client.getFriendList();
            return {
              output: `获取到 ${friends.length} 个好友：\n${truncateForToolResponse(friends)}`,
            };
          }
          case "group_history": {
            if (!params.group_id) return { output: "group_history 需要 group_id 参数" };
            const history = await client.getGroupMsgHistory(params.group_id);
            return {
              output: `群 ${params.group_id} 消息历史：\n${truncateForToolResponse(history)}`,
            };
          }
          case "group_info": {
            if (!params.group_id) return { output: "group_info 需要 group_id 参数" };
            const info = await client.getGroupInfo(params.group_id);
            return {
              output: `群 ${params.group_id} 详情：\n${truncateForToolResponse(info)}`,
            };
          }
          case "get_message": {
            if (!params.message_id) return { output: "get_message 需要 message_id 参数" };
            const msg = await client.getMsg(params.message_id);
            return {
              output: `消息详情：\n${truncateForToolResponse(msg)}`,
            };
          }
          default:
            return { output: `未知操作：${String((params as any).action)}` };
        }
      } catch (err) {
        return { output: `获取失败：${String(err)}` };
      }
    },
  };
}

export function createQQForwardMessageTool(_ctx?: any) {
  return {
    name: "qq_forward_message",
    label: "QQ 合并转发",
    description:
      "向 QQ 群或私聊发送合并转发消息，可包含多条消息节点。仅管理员可触发。",
    parameters: QQForwardMessageSchema,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
    ) => {
      const params = rawParams as QQForwardMessageParams;
      const { client, error } = resolveClient();
      if (!client) return { output: error };

      const selfId = client.getSelfId();
      const defaultUin = selfId ? String(selfId) : "10000";

      const forwardNodes = await Promise.all(params.messages.map(async (msg) => ({
        type: "node" as const,
        data: {
          name: msg.name,
          uin: defaultUin,
          content: await resolveForwardNodeContent(msg.content),
        },
      })));

      try {
        if (params.target_type === "group") {
          // 群合并转发：先尝试 send_group_forward_msg，失败尝试 send_forward_msg
          let lastErr: unknown;
          try {
            await (client as any).sendWithResponse(
              "send_group_forward_msg",
              { group_id: params.target_id, messages: forwardNodes },
              15000,
            );
            return {
              output: `已向群 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点）`,
            };
          } catch (e) { lastErr = e; }
          try {
            await (client as any).sendWithResponse(
              "send_forward_msg",
              { group_id: params.target_id, messages: forwardNodes },
              15000,
            );
            return {
              output: `已向群 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点，fallback）`,
            };
          } catch (e) {
            return { output: `合并转发失败（两种 API 均失败）：\n- send_group_forward_msg: ${String(lastErr)}\n- send_forward_msg: ${String(e)}` };
          }
        }

        // 私聊合并转发
        let lastErr: unknown;
        try {
          await (client as any).sendWithResponse(
            "send_private_forward_msg",
            { user_id: params.target_id, messages: forwardNodes },
            15000,
          );
          return {
            output: `已向用户 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点）`,
          };
        } catch (e) { lastErr = e; }
        try {
          await (client as any).sendWithResponse(
            "send_forward_msg",
            { user_id: params.target_id, messages: forwardNodes },
            15000,
          );
          return {
            output: `已向用户 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点，fallback）`,
          };
        } catch (e) {
          return { output: `合并转发失败（两种 API 均失败）：\n- send_private_forward_msg: ${String(lastErr)}\n- send_forward_msg: ${String(e)}` };
        }
    },
  };
}
