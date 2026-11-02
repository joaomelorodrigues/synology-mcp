/**
 * Tool definitions and registration. A tool is registered only when the configured tier allows
 * it, its module is enabled and the NAS actually offers the API it needs. So a read-only
 * connection has no write tools to misuse, and packages that aren't installed cost nothing in
 * the client's context.
 */
import { TIERS } from '../config.js';
import { DsmError } from '../dsm/errors.js';
import { renderError, renderResult } from './format.js';
/** Define a tool with its handler's arguments inferred from the input shape. */
export function tool(def) {
    return def;
}
function tierRank(tier) {
    return TIERS.indexOf(tier);
}
export function selectTools(defs, config, has) {
    const selection = { active: [], hidden: [] };
    for (const def of defs) {
        const hide = (reason, detail) => {
            selection.hidden.push({ name: def.name, module: def.module, reason, detail });
        };
        if (config.modules !== 'all' && !config.modules.includes(def.module)) {
            hide('module', `module "${def.module}" is not enabled`);
        }
        else if (def.tier === 'power') {
            if (config.allowPower)
                selection.active.push(def);
            else
                hide('power', 'needs allowPower: true');
        }
        else if (tierRank(def.tier) > tierRank(config.tier)) {
            hide('tier', `needs tier "${def.tier}" (this connection is "${config.tier}")`);
        }
        else if (def.needsSpreadsheetApi && !config.spreadsheetApiUrl) {
            hide('config', 'needs the Spreadsheet API container; see `synology-mcp spreadsheet-setup`');
        }
        else if (def.requires && !def.requires.every(has)) {
            hide('package', `NAS lacks ${def.requires.filter((api) => !has(api)).join(', ')}`);
        }
        else if (def.requiresAny && !def.requiresAny.some(has)) {
            hide('package', `NAS lacks all of ${def.requiresAny.join(', ')}`);
        }
        else {
            selection.active.push(def);
        }
    }
    return selection;
}
export function registerTools(server, selection, deps) {
    for (const def of selection.active) {
        const readOnly = def.tier === 'read' && !def.localWrite;
        server.registerTool(def.name, {
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
        }, async (args, extra) => {
            let lastProgress = -1;
            const context = {
                ...deps,
                selection,
                signal: extra.signal,
                progress: async (done, total, message) => {
                    const token = extra._meta?.progressToken;
                    if (token === undefined)
                        return;
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
            }
            catch (error) {
                const mapped = error instanceof DsmError ? error : deps.client.toDsmError(error);
                return { isError: true, content: [{ type: 'text', text: renderError(mapped) }] };
            }
        });
    }
}
/** The dry-run reply of a destructive tool: shows what would happen and how to go ahead. */
export function confirmationNeeded(preview) {
    return {
        confirm_required: true,
        nothing_changed: true,
        ...preview,
        next_step: 'Show this to the user. If they agree, call again with confirm=true.',
    };
}
