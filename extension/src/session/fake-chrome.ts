/**
 * A stand-in for the slice of `chrome.*` the session code uses, for the
 * unit tests only (never imported by an entry point, so never bundled).
 * Storage, tabs and groups are plain maps a test can read, seed, copy into
 * a fresh environment (a "restart" after a killed context), or make hang at
 * a chosen step.
 */
import type { BridgeClient, BridgeResult, PostEventResult } from "../shared/bridge-client";
import type { CommandsResponse, EventsRequest, OpenApplicationGroup, StatusResponse } from "@workflow-catalog/contracts";

export interface FakeTab {
  id: number;
  url: string;
  groupId: number;
  active: boolean;
}

export interface FakeGroup {
  id: number;
  title?: string;
  color?: string;
}

export interface FakeState {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  tabs: Map<number, FakeTab>;
  groups: Map<number, FakeGroup>;
  alarms: Map<string, { delayInMinutes?: number; periodInMinutes?: number; when?: number }>;
  nextTabId: number;
  nextGroupId: number;
}

export interface FakeHooks {
  /** Runs before a `tabs.create` resolves, with the tab already created; return a promise that never settles to hang there. */
  afterCreate?: (tab: FakeTab, index: number) => Promise<void> | void;
  beforeCreate?: (index: number) => Promise<void> | void;
  beforeGroup?: () => Promise<void> | void;
  beforeNameGroup?: () => Promise<void> | void;
  /** Runs before a `storage.local.set` writes. */
  beforeLocalSet?: (items: Record<string, unknown>) => Promise<void> | void;
}

export interface FakeChrome {
  readonly state: FakeState;
  readonly hooks: FakeHooks;
  readonly listeners: {
    removed: Array<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>;
    replaced: Array<(added: number, removed: number) => void>;
    activated: Array<(info: { tabId: number; windowId: number }) => void>;
    alarm: Array<(alarm: { name: string }) => void>;
    changed: Array<(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, areaName: string) => void>;
  };
  readonly calls: { create: number; group: number; nameGroup: number };
  /** Closes a tab the way a person would: it goes, and onRemoved fires. */
  closeTab(tabId: number): void;
  /** A copy of everything that outlives a context (storage, tabs, groups), for a fresh environment. */
  snapshot(): FakeState;
}

export function emptyState(): FakeState {
  return { local: {}, session: {}, tabs: new Map(), groups: new Map(), alarms: new Map(), nextTabId: 100, nextGroupId: 7 };
}

function copyState(state: FakeState): FakeState {
  return {
    local: structuredClone(state.local),
    session: structuredClone(state.session),
    tabs: new Map([...state.tabs].map(([id, tab]) => [id, { ...tab }])),
    groups: new Map([...state.groups].map(([id, group]) => [id, { ...group }])),
    alarms: new Map(state.alarms),
    nextTabId: state.nextTabId,
    nextGroupId: state.nextGroupId,
  };
}

function area(data: Record<string, unknown>, name: string, fake: () => FakeChrome, beforeSet?: (items: Record<string, unknown>) => Promise<void> | void) {
  return {
    async get(keys?: string | string[] | null) {
      if (keys === undefined || keys === null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      await beforeSet?.(items);
      const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = structuredClone(value);
      }
      for (const listener of fake().listeners.changed) listener(changes, name);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}

/** Installs a fresh fake `chrome` global over `seed` (default: empty). */
export function installFakeChrome(seed: FakeState = emptyState()): FakeChrome {
  const state = copyState(seed);
  const hooks: FakeHooks = {};
  let createIndex = 0;
  const fake: FakeChrome = {
    state,
    hooks,
    listeners: { removed: [], replaced: [], activated: [], alarm: [], changed: [] },
    calls: { create: 0, group: 0, nameGroup: 0 },
    closeTab(tabId) {
      const tab = state.tabs.get(tabId);
      if (!tab) return;
      state.tabs.delete(tabId);
      for (const listener of fake.listeners.removed) listener(tabId, { windowId: 1, isWindowClosing: false });
    },
    snapshot: () => copyState(state),
  };
  const get = () => fake;
  globalThis.chrome = {
    runtime: { onInstalled: { addListener: () => undefined }, openOptionsPage: async () => undefined },
    storage: {
      local: area(state.local, "local", get, (items) => hooks.beforeLocalSet?.(items)),
      session: area(state.session, "session", get),
      onChanged: { addListener: (listener: FakeChrome["listeners"]["changed"][number]) => fake.listeners.changed.push(listener) },
    },
    alarms: {
      onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => fake.listeners.alarm.push(listener) },
      async create(name: string, info: { delayInMinutes?: number; periodInMinutes?: number; when?: number }) {
        state.alarms.set(name, info);
      },
      async get(name: string) {
        const info = state.alarms.get(name);
        return info ? { name, scheduledTime: 0, ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) } : undefined;
      },
      async clear(name: string) {
        return state.alarms.delete(name);
      },
    },
    tabs: {
      async create(options: { url: string; active?: boolean }) {
        const index = createIndex;
        createIndex += 1;
        await hooks.beforeCreate?.(index);
        fake.calls.create += 1;
        const tab: FakeTab = { id: state.nextTabId, url: options.url, groupId: -1, active: options.active === true };
        state.nextTabId += 1;
        state.tabs.set(tab.id, tab);
        await hooks.afterCreate?.(tab, index);
        return { id: tab.id, index, windowId: 1, groupId: -1, active: tab.active };
      },
      async group(options: { tabIds: number[] }) {
        await hooks.beforeGroup?.();
        fake.calls.group += 1;
        for (const id of options.tabIds) if (!state.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        const group: FakeGroup = { id: state.nextGroupId };
        state.nextGroupId += 1;
        state.groups.set(group.id, group);
        for (const id of options.tabIds) state.tabs.get(id)!.groupId = group.id;
        return group.id;
      },
      async get(tabId: number) {
        const tab = state.tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return { id: tab.id, groupId: tab.groupId, active: tab.active, windowId: 1, index: 0 };
      },
      async query(query: { active?: boolean }) {
        return [...state.tabs.values()].filter((tab) => query.active === undefined || tab.active === query.active).map((tab) => ({ id: tab.id, active: tab.active, windowId: 1, index: 0, groupId: tab.groupId }));
      },
      async update(tabId: number, info: { active?: boolean }) {
        if (info.active) for (const tab of state.tabs.values()) tab.active = tab.id === tabId;
        return { id: tabId };
      },
      onRemoved: { addListener: (listener: FakeChrome["listeners"]["removed"][number]) => fake.listeners.removed.push(listener) },
      onReplaced: { addListener: (listener: FakeChrome["listeners"]["replaced"][number]) => fake.listeners.replaced.push(listener) },
      onActivated: { addListener: (listener: FakeChrome["listeners"]["activated"][number]) => fake.listeners.activated.push(listener) },
    },
    tabGroups: {
      async update(groupId: number, info: { title?: string; color?: string }) {
        await hooks.beforeNameGroup?.();
        fake.calls.nameGroup += 1;
        const group = state.groups.get(groupId);
        if (!group) throw new Error(`No group with id: ${groupId}.`);
        Object.assign(group, info);
        return group;
      },
      async query(query: { title?: string }) {
        return [...state.groups.values()].filter((group) => query.title === undefined || group.title === query.title);
      },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    sidePanel: { open: async () => undefined },
  } as unknown as typeof chrome;
  return fake;
}

/** A promise that never settles: a context that stopped mid-step. */
export function never(): Promise<void> {
  return new Promise(() => undefined);
}

export interface FakeBridge {
  readonly client: BridgeClient;
  readonly posted: EventsRequest[];
  commands: OpenApplicationGroup[];
  /** Decides each POST /events answer; default: accepted, with the runner-shaped result. */
  answer: (event: EventsRequest) => BridgeResult<PostEventResult> | Promise<BridgeResult<PostEventResult>>;
  /** Application revisions the fake runner answers with, by taskId (default 1). */
  revisions: Map<string, number>;
  stages: Map<string, string>;
}

/** A bridge client standing in for the runner, answering the way P06's handlers do. */
export function fakeBridge(): FakeBridge {
  const bridge: FakeBridge = {
    posted: [],
    commands: [],
    revisions: new Map(),
    stages: new Map(),
    answer: (event) => {
      if (event.type === "browser_command_result") {
        return {
          ok: true,
          value: {
            duplicate: false,
            result: { sessionId: "x", flagged: 0, items: event.items.map((item) => ({ taskId: item.taskId, stage: bridge.stages.get(item.taskId) ?? "ready", revision: bridge.revisions.get(item.taskId) ?? 1 })) },
          },
        };
      }
      if (event.type === "application_status_changed") {
        const revision = bridge.revisions.get(event.taskId) ?? 1;
        if (event.expectedRevision !== revision) return { ok: false, error: { status: 409, code: "stale_revision", message: "stale" } };
        if (event.status === "applied") {
          bridge.revisions.set(event.taskId, revision + 1);
          bridge.stages.set(event.taskId, "applied");
        }
        return { ok: true, value: { duplicate: false, result: { taskId: event.taskId, outcome: event.status, stage: bridge.stages.get(event.taskId) ?? "ready", revision: bridge.revisions.get(event.taskId) ?? 1 } } };
      }
      return { ok: true, value: { duplicate: false } };
    },
    client: {
      pair: async () => ({ ok: false, error: { code: "not_used", message: "not used" } }),
      async postEvent(event) {
        bridge.posted.push(structuredClone(event));
        return bridge.answer(event);
      },
      async getCommands(): Promise<BridgeResult<CommandsResponse>> {
        return { ok: true, value: { commands: structuredClone(bridge.commands) } };
      },
      async getStatus(): Promise<BridgeResult<StatusResponse>> {
        return { ok: false, error: { code: "not_used", message: "not used" } };
      },
    },
  };
  return bridge;
}

export const DEVICE_ID = "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f";
export const OTHER_DEVICE_ID = "9c1d7a1f-3a2b-4d66-8e4f-1b2c3d4e5f60";

/** Stores a fictional pairing for `DEVICE_ID`. */
export async function pair(deviceId = DEVICE_ID): Promise<void> {
  await chrome.storage.session.set({ deviceToken: { deviceId, token: "fictional-token", pairedAt: "2026-09-25T09:00:00.000Z" } });
}

export const TASKS = ["7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f", "2e4f6a8b-0c1d-4e3f-9a5b-7c9d1e3f5a7b", "4a6c8e0a-2b3c-4d5e-8f6a-7b8c9d0e1f2a"] as const;

/** A fictional `open_application_group` command for this device, live for a day. */
export function command(overrides: Partial<OpenApplicationGroup> = {}, items: OpenApplicationGroup["payload"]["items"] = TASKS.map((taskId, index) => ({ taskId, jobRevision: 1, url: `https://jobs.example/postings/fictional-${index + 1}` }))): OpenApplicationGroup {
  return {
    protocol: 1,
    type: "open_application_group",
    commandId: "0d2e8b20-4b3c-4e77-9f50-2c3d4e5f6071",
    deviceId: DEVICE_ID,
    sessionId: "5b6f1c2e-8d4a-4f3b-9c1d-2e3f4a5b6c7d",
    workflowVersion: "job-assistant@0",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    payload: { title: "Apply today", items },
    ...overrides,
  };
}
