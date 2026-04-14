import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { OneBotClient } from "./client.js";

let runtime: PluginRuntime | null = null;

// 客户端注册表，供 tool 层访问
const registeredClients = new Map<string, OneBotClient>();
const registeredConfigs = new Map<string, Record<string, unknown>>();

export function setQQRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getQQRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQ runtime not initialized");
  }
  return runtime;
}

// 注册/注销客户端实例（由 channel.ts gateway.startAccount 调用）
export function registerQQClient(accountId: string, client: OneBotClient, config?: Record<string, unknown>) {
  registeredClients.set(accountId, client);
  if (config) registeredConfigs.set(accountId, config);
}

export function unregisterQQClient(accountId: string) {
  registeredClients.delete(accountId);
  registeredConfigs.delete(accountId);
}

export function getRegisteredClient(accountId?: string): OneBotClient | undefined {
  if (accountId) return registeredClients.get(accountId);
  // 单账号时直接返回唯一实例
  if (registeredClients.size === 1) return registeredClients.values().next().value;
  return undefined;
}

export function getRegisteredConfig(accountId?: string): Record<string, unknown> | undefined {
  if (accountId) return registeredConfigs.get(accountId);
  if (registeredConfigs.size === 1) return registeredConfigs.values().next().value;
  return undefined;
}

export function getAllRegisteredClients(): Map<string, OneBotClient> {
  return registeredClients;
}
