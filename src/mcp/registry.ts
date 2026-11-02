/**
 * Tool definitions and registration. A tool is registered only when the configured tier allows
 * it, its module is enabled and the NAS actually offers the API it needs. So a read-only
 * connection has no write tools to misuse, and packages that aren't installed cost nothing in
 * the client's context.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { Config, ModuleName, Tier } from '../config.js';
import { TIERS } from '../config.js';
import type { CredentialProvider } from '../credentials.js';
import type { DsmClient } from '../dsm/client.js';
import { DsmError } from '../dsm/errors.js';
import { renderError, renderResult } from './format.js';

export type ToolTier = Tier | 'power';

export interface ToolContext {
  client: DsmClient;
  config: Config;
  credentials: CredentialProvider;
  signal: AbortSignal;
  /** Report progress to the client, keeping long calls from hitting its idle timeout. */
  progress(done: number, total?: number, message?: string): Promise<void>;
  /** What this connection exposes, for the capabilities tool. */
  selection: Selection;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  module: ModuleName;
  tier: ToolTier;
  /** APIs that must all exist on the NAS. */
  requires?: string[];
  /** At least one of these must exist. */
  requiresAny?: string[];
  input?: z.ZodRawShape;
  destructive?: boolean;
  idempotent?: boolean;
  /** Reads the NAS but writes on this machine, so clients should not treat it as read-only. */
  localWrite?: boolean;
  handler(args: any, context: ToolContext): Promise<unknown>;
}

/** Define a tool with its handler's arguments inferred from the input shape. */
export function tool<S extends z.ZodRawShape>(
  def: Omit<ToolDef, 'input' | 'handler'> & {
    input?: S;
    handler(args: z.infer<z.ZodObject<S>>, context: ToolContext): Promise<unknown>;
  },
): ToolDef {
  return def as unknown as ToolDef;
}

export interface HiddenTool {
  name: string;
  module: ModuleName;
  reason: 'tier' | 'power' | 'module' | 'package';
  detail: string;
}

export interface Selection {
  active: ToolDef[];
  hidden: HiddenTool[];
}

function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function selectTools(defs: readonly ToolDef[], config: Config, has: (api: string) => boolean): Selection {
  const selection: Selection = { active: [], hidden: [] };
  for (const def of defs) {
    const hide = (reason: HiddenTool['reason'], detail: string): void => {
      selection.hidden.push({ name: def.name, module: def.module, reason, detail });
    };
    if (config.modules !== 'all' && !config.modules.includes(def.module)) {
      hide('module', `module "${def.module}" is not enabled`);
    } else if (def.tier === 'power') {
      if (config.allowPower) selection.active.push(def);
      else hide('power', 'needs allowPower: true');
    } else if (tierRank(def.tier) > tierRank(config.tier)) {
      hide('tier', `needs tier "${def.tier}" (this connection is "${config.tier}")`);
    } else if (def.requires && !def.requires.every(has)) {
      hide('package', `NAS lacks ${def.requires.filter((api) => !has(api)).join(', ')}`);
    } else if (def.requiresAny && !def.requiresAny.some(has)) {
      hide('package', `NAS lacks all of ${def.requiresAny.join(', ')}`);
    } else {
      selection.active.push(def);
    }
  }
  return selection;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface RegisterDeps {
  client: DsmClient;
  config: Config;
  credentials: CredentialProvider;
}

export function registerTools(server: McpServer, selection: Selection, deps: RegisterDeps): void {
  for (const def of selection.active) {
    const readOnly = def.tier === 'read' && !def.localWrite;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input ?? {},
        annotations: {
          title: def.title,
          readOnlyHint: readOnly,
          destructiveHint: def.localWrite
            ? true
            : readOnly
              ? false
              : (def.destructive ?? (def.tier === 'admin' || def.tier === 'power')),
          idempotentHint: def.idempotent ?? readOnly,
          openWorldHint: false,
        },
      },
      async (args: unknown, extra: Extra): Promise<CallToolResult> => {
        let lastProgress = -1;
        const context: ToolContext = {
          ...deps,
          selection,
          signal: extra.signal,
          progress: async (done, total, message) => {
            const token = extra._meta?.progressToken;
            if (token === undefined) return;
            // MCP requires progress to increase, but a tool working through several paths restarts.
            const regressed = done <= lastProgress;
            lastProgress = regressed ? lastProgress + 0.01 : done;
            await extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: lastProgress, total: regressed ? undefined : total, message },
              })
              .catch(() => undefined);
          },
        };
        try {
          const result = await def.handler(args ?? {}, context);
          return { content: [{ type: 'text', text: renderResult(result, deps.config.maxOutputChars) }] };
        } catch (error) {
          const mapped = error instanceof DsmError ? error : deps.client.toDsmError(error);
          return { isError: true, content: [{ type: 'text', text: renderError(mapped) }] };
        }
      },
    );
  }
}

/** The dry-run reply of a destructive tool: shows what would happen and how to go ahead. */
export function confirmationNeeded(preview: Record<string, unknown>): Record<string, unknown> {
  return {
    confirm_required: true,
    nothing_changed: true,
    ...preview,
    next_step: 'Show this to the user. If they agree, call again with confirm=true.',
  };
}
