/**
 * QQ 主动能力 Tool —— 让 Agent 可以主动发消息、查上下文、转发消息
 *
 * 安全约束：
 * - 所有 tool 仅在当前对话由 admins 白名单用户触发时可用
 * - 发送频率受限于 OneBotClient 本身的队列
 */

import { getRegisteredClient } from "./runtime.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

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
      description: "要发送的消息文本内容。纯发图片时可留空，改用 image_path 参数。",
      maxLength: 4500,
    },
    image_path: {
      type: "string" as const,
      description: "图片文件路径。填 'browser:latest' 发送最近一次 browser 截图，或填绝对/相对路径指定图片文件。browser 截图后直接用 'browser:latest' 即可，不要用 write 写文件。",
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
  required: ["target_type", "target_id"],
  additionalProperties: false,
};

const QQGetContextSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["group_list", "friend_list", "group_history", "group_info", "get_message"],
      description: "操作类型：group_list（群列表）、friend_list（好友列表）、group_history（群消息历史）、group_info（群详情）、get_message（获取单条消息）",
    },
    group_id: {
      type: "number" as const,
      description: "群号（group_history 和 group_info 时必填）",
    },
    message_id: {
      type: "string" as const,
      description: "消息 ID（get_message 时必填）",
    },
    count: {
      type: "number" as const,
      description: "获取消息数量（group_history 时可选，默认 20，最大 50）",
      minimum: 1,
      maximum: 50,
    },
    message_seq: {
      type: "string" as const,
      description: "起始消息序号（group_history 时可选，不传则获取最新消息）。可通过 get_message 获取消息的 seq",
    },
    reverse_order: {
      type: "boolean" as const,
      description: "是否倒序返回（group_history 时可选，默认 false）",
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

const QQRecallMessageSchema = {
  type: "object" as const,
  properties: {
    message_id: {
      type: "string" as const,
      description: "要撤回的消息 ID",
    },
  },
  required: ["message_id"],
  additionalProperties: false,
};

const QQBatchRecallMessagesSchema = {
  type: "object" as const,
  properties: {
    message_ids: {
      type: "array" as const,
      description: "要撤回的消息 ID 列表",
      items: { type: "string" as const },
      minItems: 1,
      maxItems: 50,
    },
  },
  required: ["message_ids"],
  additionalProperties: false,
};

interface QQSendMessageParams {
  target_type: "group" | "private";
  target_id: number;
  message: string;
  image_path?: string;
  forward?: boolean;
  forward_node_name?: string;
}

interface QQGetContextParams {
  action: "group_list" | "friend_list" | "group_history" | "group_info" | "get_message";
  group_id?: number;
  message_id?: string;
  count?: number;
  message_seq?: string;
  reverse_order?: boolean;
}

interface QQForwardMessageParams {
  target_type: "group" | "private";
  target_id: number;
  messages: Array<{ name: string; content: string }>;
}

interface QQRecallMessageParams {
  message_id: string;
}

interface QQBatchRecallMessagesParams {
  message_ids: string[];
}

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * workspace 目录：Agent 的工作目录，MEDIA: 相对路径基于此解析
 */
const WORKSPACE_DIR = resolve(homedir(), ".openclaw", "workspace");

/**
 * 解析文件路径：相对路径基于 workspace 目录，绝对路径直接使用
 */
function resolveFilePath(rawPath: string): string {
  if (isAbsolute(rawPath)) return rawPath;
  return resolve(WORKSPACE_DIR, rawPath);
}

/**
 * PNG/JPEG/GIF/WEBP 文件头 magic bytes 检查
 */
const IMAGE_SIGNATURES: Array<{ ext: string; header: number[] }> = [
  { ext: "png", header: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "jpeg", header: [0xff, 0xd8, 0xff] },
  { ext: "gif", header: [0x47, 0x49, 0x46] },
  { ext: "webp", header: [0x52, 0x49, 0x46, 0x46] },
  { ext: "bmp", header: [0x42, 0x4d] },
];

function isValidImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  return IMAGE_SIGNATURES.some(sig =>
    sig.header.every((byte, i) => buffer[i] === byte)
  );
}

/**
 * 将 MEDIA: 前缀的文件路径转换为 base64 图片 CQ 码。
 * NapCat 运行在远程 VPS，无法访问容器本地文件，
 * 因此需要将图片读取为 base64 再发送。
 * 支持整段 MEDIA: 前缀，也支持文本中嵌入的 MEDIA: 前缀。
 */
async function resolveMediaContent(content: string): Promise<string> {
  const mediaRegex = /MEDIA:(\S+)/g;
  let match: RegExpExecArray | null;
  const replacements: Array<{ full: string; replacement: string }> = [];

  while ((match = mediaRegex.exec(content)) !== null) {
    const rawPath = match[1];
    const filePath = resolveFilePath(rawPath);
    if (existsSync(filePath)) {
      try {
        const buffer = await readFile(filePath);
        if (isValidImageBuffer(buffer)) {
          // 直接是二进制图片
          const base64 = buffer.toString("base64");
          replacements.push({ full: match[0], replacement: `[CQ:image,file=base64://${base64}]` });
          continue;
        }
        // Agent 可能用 write 工具把 base64 文本写入了文件（未解码），尝试当 base64 解码
        const text = buffer.toString("utf-8").trim();
        if (/^[A-Za-z0-9+/]+=*$/.test(text) && text.length > 100) {
          const decoded = Buffer.from(text, "base64");
          if (isValidImageBuffer(decoded)) {
            replacements.push({ full: match[0], replacement: `[CQ:image,file=base64://${text}]` });
            continue;
          }
        }
        replacements.push({ full: match[0], replacement: `[图片无效：${rawPath} 不是有效的图片文件（${buffer.length} 字节）]` });
      } catch {
        // 读取失败保留原文
      }
    }
  }

  if (replacements.length === 0) return content;

  let result = content;
  for (const { full, replacement } of replacements) {
    result = result.replace(full, replacement);
  }
  return result;
}

/**
 * 将 content 转换为合并转发节点的消息段数组格式。
 * OneBot 合并转发节点的 content 支持消息段数组，
 * 这比 CQ 码字符串兼容性更好。
 */
async function resolveForwardNodeContent(content: string): Promise<string | Array<{ type: string; data: Record<string, unknown> }>> {
  const mediaRegex = /MEDIA:(\S+)/;
  const match = mediaRegex.exec(content);
  if (!match) return content;

  const rawPath = match[1];
  const filePath = resolveFilePath(rawPath);
  if (!existsSync(filePath)) return content;

  try {
    const buffer = await readFile(filePath);
    if (isValidImageBuffer(buffer)) {
      const base64 = buffer.toString("base64");
      return [{ type: "image", data: { file: `base64://${base64}` } }];
    }
    // 尝试当 base64 文本解码
    const text = buffer.toString("utf-8").trim();
    if (/^[A-Za-z0-9+/]+=*$/.test(text) && text.length > 100) {
      const decoded = Buffer.from(text, "base64");
      if (isValidImageBuffer(decoded)) {
        return [{ type: "image", data: { file: `base64://${text}` } }];
      }
    }
    return `[图片无效：${rawPath} 不是有效的图片文件（${buffer.length} 字节）]`;
  } catch {
    return content;
  }
}

const BROWSER_MEDIA_DIR = resolve(homedir(), ".openclaw", "media", "browser");

/**
 * 解析 image_path 参数为 CQ 图片码。
 * 支持 browser:latest 快捷方式（最近一次 browser 截图）。
 */
async function resolveImagePath(imagePath: string): Promise<string> {
  let filePath: string;

  if (imagePath === "browser:latest") {
    // 查找 browser 媒体目录中最新的文件
    if (!existsSync(BROWSER_MEDIA_DIR)) {
      return "[错误：browser 媒体目录不存在，请先使用 browser 截图]";
    }
    const { readdirSync, statSync } = require("node:fs");
    const files = (readdirSync(BROWSER_MEDIA_DIR) as string[])
      .map((name: string) => ({ name, mtime: statSync(resolve(BROWSER_MEDIA_DIR, name)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    if (files.length === 0) {
      return "[错误：browser 媒体目录为空，请先使用 browser 截图]";
    }
    filePath = resolve(BROWSER_MEDIA_DIR, files[0].name);
  } else {
    filePath = resolveFilePath(imagePath);
  }

  if (!existsSync(filePath)) {
    return `[错误：图片文件不存在：${filePath}]`;
  }

  const buffer = await readFile(filePath);
  if (isValidImageBuffer(buffer)) {
    const base64 = buffer.toString("base64");
    return `[CQ:image,file=base64://${base64}]`;
  }
  // 尝试 base64 文本
  const text = buffer.toString("utf-8").trim();
  if (/^[A-Za-z0-9+/]+=*$/.test(text) && text.length > 100) {
    const decoded = Buffer.from(text, "base64");
    if (isValidImageBuffer(decoded)) {
      return `[CQ:image,file=base64://${text}]`;
    }
  }
  return `[图片无效：${imagePath} 不是有效的图片文件（${buffer.length} 字节）]`;
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

/** 将消息段数组/CQ码/字符串精简为可读摘要 */
function summarizeMessageContent(msg: unknown): string {
  if (typeof msg === "string") return msg.slice(0, 200);
  if (!Array.isArray(msg)) return String(msg ?? "").slice(0, 200);
  return msg.map((seg: any) => {
    switch (seg?.type) {
      case "text": return seg.data?.text ?? "";
      case "image": return "[图片]";
      case "face": return `[表情:${seg.data?.id ?? "?"}]`;
      case "at": return `@${seg.data?.qq ?? "?"}`;
      case "reply": return `[回复:${seg.data?.id ?? "?"}]`;
      case "record": return "[语音]";
      case "video": return "[视频]";
      case "file": return `[文件:${seg.data?.name ?? seg.data?.file ?? "?"}]`;
      case "forward": return "[合并转发]";
      case "json": return "[JSON卡片]";
      case "xml": return "[XML卡片]";
      default: return `[${seg?.type ?? "?"}]`;
    }
  }).join("").slice(0, 300);
}

/** 统一工具返回值格式，符合 AgentToolResult 规范 */
function toolResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

// ─── Tool 工厂 ─────────────────────────────────────────────

export function createQQSendMessageTool(_ctx?: any) {
  return {
    name: "qq_send_message",
    label: "QQ 发送消息",
    description: "向 QQ 群或私聊主动发送消息。支持文本、图片和混合消息。发送 browser 截图时使用 image_path='browser:latest'。仅管理员可触发。",
    parameters: QQSendMessageSchema,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const params = rawParams as QQSendMessageParams;
      const { client, error } = resolveClient();
      if (!client) return toolResult(error!);

      if (!params.message && !params.image_path) {
        return toolResult("message 和 image_path 至少需要提供一个");
      }

      // 构建最终消息
      let resolvedMessage: string = "";
      const parts: string[] = [];

      // 处理文本消息（含 MEDIA: 前缀）
      if (params.message) {
        parts.push(await resolveMediaContent(params.message));
      }

      // 处理 image_path 参数
      if (params.image_path) {
        const imgCQ = await resolveImagePath(params.image_path);
        parts.push(imgCQ);
      }

      resolvedMessage = parts.join("");

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
              await (client as any).sendWithResponse("send_group_forward_msg", { group_id: params.target_id, messages }, 15000);
            } catch {
              await (client as any).sendWithResponse("send_forward_msg", { group_id: params.target_id, messages }, 15000);
            }
            return toolResult(`已向群 ${params.target_id} 发送合并转发消息`);
          }
          const ack = await client.sendGroupMsgAck(params.target_id, resolvedMessage);
          const msgId = ack?.message_id ?? "unknown";
          return toolResult(`已向群 ${params.target_id} 发送消息（message_id: ${msgId}）`);
        }

        // 私聊
        const ack = await client.sendPrivateMsgAck(params.target_id, resolvedMessage);
        const msgId = ack?.message_id ?? "unknown";
        return toolResult(`已向用户 ${params.target_id} 发送私聊消息（message_id: ${msgId}）`);
      } catch (err) {
        return toolResult(`发送失败：${String(err)}`);
      }
    },
  };
}

export function createQQGetContextTool(_ctx?: any) {
  return {
    name: "qq_get_context",
    label: "QQ 获取上下文",
    description: "获取 QQ 群列表、好友列表、群消息历史、群详情或单条消息内容。仅管理员可触发。",
    parameters: QQGetContextSchema,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const params = rawParams as QQGetContextParams;
      const { client, error } = resolveClient();
      if (!client) return toolResult(error!);

      try {
        switch (params.action) {
          case "group_list": {
            const groups = await client.getGroupList();
            return toolResult(`获取到 ${groups.length} 个群：\n${truncateForToolResponse(groups)}`, groups);
          }
          case "friend_list": {
            const friends = await client.getFriendList();
            return toolResult(`获取到 ${friends.length} 个好友：\n${truncateForToolResponse(friends)}`, friends);
          }
          case "group_history": {
            if (!params.group_id) return toolResult("group_history 需要 group_id 参数");
            const historyParams: Record<string, unknown> = { group_id: params.group_id };
            if (params.message_seq) historyParams.message_seq = params.message_seq;
            if (params.count) historyParams.count = Math.min(params.count, 50);
            if (params.reverse_order) historyParams.reverseOrder = params.reverse_order;
            const history = await (client as any).sendWithResponse("get_group_msg_history", historyParams, 15000);
            const rawMessages = history?.messages ?? history;
            const msgCount = Array.isArray(rawMessages) ? rawMessages.length : "?";
            // 精简消息，只保留关键字段防止 Agent 上下文溢出
            const condensed = Array.isArray(rawMessages)
              ? rawMessages.map((m: any) => ({
                  message_id: m.message_id,
                  sender: m.sender?.nickname || m.sender?.card || m.user_id,
                  user_id: m.user_id || m.sender?.user_id,
                  time: m.time,
                  content: summarizeMessageContent(m.message ?? m.raw_message),
                }))
              : rawMessages;
            return toolResult(`群 ${params.group_id} 消息历史（${msgCount} 条）：\n${truncateForToolResponse(condensed)}`, condensed);
          }
          case "group_info": {
            if (!params.group_id) return toolResult("group_info 需要 group_id 参数");
            const info = await client.getGroupInfo(params.group_id);
            return toolResult(`群 ${params.group_id} 详情：\n${truncateForToolResponse(info)}`, info);
          }
          case "get_message": {
            if (!params.message_id) return toolResult("get_message 需要 message_id 参数");
            const msg = await client.getMsg(params.message_id);
            return toolResult(`消息详情：\n${truncateForToolResponse(msg)}`, msg);
          }
          default:
            return toolResult(`未知操作：${String((params as any).action)}`);
        }
      } catch (err) {
        return toolResult(`获取失败：${String(err)}`);
      }
    },
  };
}

export function createQQForwardMessageTool(_ctx?: any) {
  return {
    name: "qq_forward_message",
    label: "QQ 合并转发",
    description: "向 QQ 群或私聊发送合并转发消息，可包含多条消息节点。仅管理员可触发。",
    parameters: QQForwardMessageSchema,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const params = rawParams as QQForwardMessageParams;
      const { client, error } = resolveClient();
      if (!client) return toolResult(error!);

      const selfId = client.getSelfId();
      const defaultUin = selfId ? String(selfId) : "10000";

      const forwardNodes = await Promise.all(
        params.messages.map(async (msg) => ({
          type: "node" as const,
          data: {
            name: msg.name,
            uin: defaultUin,
            content: await resolveForwardNodeContent(msg.content),
          },
        })),
      );

      if (params.target_type === "group") {
        // 群合并转发：先尝试 send_group_forward_msg，失败尝试 send_forward_msg
        let lastErr: unknown;
        try {
          await (client as any).sendWithResponse("send_group_forward_msg", { group_id: params.target_id, messages: forwardNodes }, 15000);
          return toolResult(`已向群 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点）`);
        } catch (e) {
          lastErr = e;
        }
        try {
          await (client as any).sendWithResponse("send_forward_msg", { group_id: params.target_id, messages: forwardNodes }, 15000);
          return toolResult(`已向群 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点，fallback）`);
        } catch (e) {
          return toolResult(`合并转发失败（两种 API 均失败）：\n- send_group_forward_msg: ${String(lastErr)}\n- send_forward_msg: ${String(e)}`);
        }
      }

      // 私聊合并转发
      {
        let lastErr: unknown;
        try {
          await (client as any).sendWithResponse("send_private_forward_msg", { user_id: params.target_id, messages: forwardNodes }, 15000);
          return toolResult(`已向用户 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点）`);
        } catch (e) {
          lastErr = e;
        }
        try {
          await (client as any).sendWithResponse("send_forward_msg", { user_id: params.target_id, messages: forwardNodes }, 15000);
          return toolResult(`已向用户 ${params.target_id} 发送合并转发消息（${forwardNodes.length} 条节点，fallback）`);
        } catch (e) {
          return toolResult(`合并转发失败（两种 API 均失败）：\n- send_private_forward_msg: ${String(lastErr)}\n- send_forward_msg: ${String(e)}`);
        }
      }
    },
  };
}

export function createQQRecallMessageTool(_ctx?: any) {
  return {
    name: "qq_recall_message",
    label: "QQ 撤回消息",
    description: "撤回一条 QQ 消息。需要提供消息 ID。仅管理员可触发。Bot 只能撤回自己发送的消息或群管理员可撤回群成员消息（2 分钟内）。",
    parameters: QQRecallMessageSchema,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const params = rawParams as QQRecallMessageParams;
      const { client, error } = resolveClient();
      if (!client) return toolResult(error!);

      try {
        await (client as any).sendWithResponse("delete_msg", { message_id: params.message_id }, 10000);
        return toolResult(`已撤回消息 ${params.message_id}`);
      } catch (err) {
        return toolResult(`撤回失败：${String(err)}`);
      }
    },
  };
}

export function createQQBatchRecallMessagesTool(_ctx?: any) {
  return {
    name: "qq_batch_recall_messages",
    label: "QQ 批量撤回消息",
    description: "批量撤回多条 QQ 消息。需要提供消息 ID 列表（最多 50 条）。仅管理员可触发。Bot 只能撤回自己发送的消息或群管理员权限可撤回的消息。",
    parameters: QQBatchRecallMessagesSchema,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const params = rawParams as QQBatchRecallMessagesParams;
      const { client, error } = resolveClient();
      if (!client) return toolResult(error!);

      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const msgId of params.message_ids) {
        try {
          await (client as any).sendWithResponse("delete_msg", { message_id: msgId }, 10000);
          results.push({ id: msgId, ok: true });
        } catch (err) {
          results.push({ id: msgId, ok: false, error: String(err) });
        }
      }

      const succeeded = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok).length;
      const summary = results.map(r => r.ok ? `✅ ${r.id}` : `❌ ${r.id}: ${r.error}`).join("\n");
      return toolResult(
        `批量撤回完成：${succeeded} 成功，${failed} 失败\n${summary}`,
        { succeeded, failed, results },
      );
    },
  };
}
