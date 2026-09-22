import type { ModelSettings } from "../agent/lib/model.ts";
import type { Clock } from "../lib/clock.ts";
import type { DoctorReport } from "../lib/doctor.ts";
import { CommandQueue } from "../store/commands.ts";
import { DeviceRegistry } from "../store/devices.ts";
import { EventJournal } from "../store/journal.ts";
import { PairingCodes } from "../store/pairing.ts";
import { UiLoginLinks } from "../store/ui-login.ts";
import type { Workspace } from "../store/workspace.ts";
import type { EveGateway } from "./eve-gateway.ts";

/**
 * What every route module and event handler receives: the workspace, the
 * runner's own stores, the clock, eve (when running) and a logger.
 *
 * The logger is for operational lines only ("paired a device", "eve is not
 * answering"). Never log content: no job text, no profile data, no model
 * input or output. Runner output is personal data (README "Privacy").
 */
export interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: RunnerLogger = {
  info: (message) => console.log(`[bridge] ${message}`),
  warn: (message) => console.warn(`[bridge] ${message}`),
  error: (message) => console.error(`[bridge] ${message}`),
};

export const silentLogger: RunnerLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface RunnerContext {
  readonly workspace: Workspace;
  readonly clock: Clock;
  readonly devices: DeviceRegistry;
  readonly pairing: PairingCodes;
  readonly uiLogin: UiLoginLinks;
  readonly journal: EventJournal;
  readonly commands: CommandQueue;
  /** eve behind the bridge (`npm run runner`); undefined when the bridge runs without it, as in tests. */
  readonly eve: EveGateway | undefined;
  /** The configured model, or undefined when setup has not recorded one. */
  readonly model: ModelSettings | undefined;
  /** The installed job-assistant package version (GET /status `version`). */
  readonly packageVersion: string;
  /** The install checklist (lib/doctor.ts) for the status page; undefined in tests that do not need it. */
  readonly checklist: (() => Promise<DoctorReport>) | undefined;
  readonly log: RunnerLogger;
}

export interface CreateContextOptions {
  readonly workspace: Workspace;
  readonly clock: Clock;
  readonly packageVersion: string;
  readonly eve?: EveGateway;
  readonly model?: ModelSettings;
  readonly checklist?: () => Promise<DoctorReport>;
  readonly log?: RunnerLogger;
}

export function createRunnerContext(options: CreateContextOptions): RunnerContext {
  const { workspace, clock } = options;
  return {
    workspace,
    clock,
    devices: new DeviceRegistry(workspace, clock),
    pairing: new PairingCodes(workspace, clock),
    uiLogin: new UiLoginLinks(workspace, clock),
    journal: new EventJournal(workspace),
    commands: new CommandQueue(workspace, clock),
    eve: options.eve,
    model: options.model,
    packageVersion: options.packageVersion,
    checklist: options.checklist,
    log: options.log ?? consoleLogger,
  };
}
