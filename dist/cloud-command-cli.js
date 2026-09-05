import { loadConfig } from "./config.js";
import { CloudCommandStore } from "./cloud-workflow.js";
import { Store } from "./store.js";
export async function cloudCommandList(input) {
    await withInbox(input.agentConfigFile, (inbox) => {
        const records = inbox.list(input.limit ?? 100);
        const output = input.output ?? console.log;
        if (input.json) {
            output(JSON.stringify(records));
            return;
        }
        if (!records.length) {
            output("No cloud commands have been received.");
            return;
        }
        for (const record of records)
            output([
                record.commandId,
                record.state,
                record.requiredScope,
                `attempt=${record.attempt}`,
                `local=${record.localAttempts}`,
                record.lastErrorCode ? `error=${record.lastErrorCode}` : undefined,
            ]
                .filter(Boolean)
                .join("\t"));
    });
}
export async function cloudCommandShow(input) {
    await withInbox(input.agentConfigFile, (inbox) => {
        const record = inbox.command(input.commandId);
        if (!record)
            throw new Error("Unknown cloud command");
        (input.output ?? console.log)(JSON.stringify(record, null, 2));
    });
}
export async function cloudCommandAction(input) {
    await withInbox(input.agentConfigFile, (inbox) => {
        const changed = input.action === "approve"
            ? inbox.approve(input.commandId)
            : input.action === "reject"
                ? inbox.reject(input.commandId, input.reasonCode ?? "operator-rejected")
                : input.action === "cancel"
                    ? inbox.cancel(input.commandId)
                    : input.action === "result-retry"
                        ? inbox.retrySubmission(input.commandId, { operatorApproved: true })
                        : inbox.retry(input.commandId);
        if (!changed)
            throw new Error(`Cloud command cannot transition through ${input.action} from its current state`);
        (input.output ?? console.log)(input.action === "result-retry"
            ? "Result submission retry scheduled; local effects will not run again."
            : `${input.action}: ${input.commandId}`);
    });
}
async function withInbox(configFile, operation) {
    const config = await loadConfig(configFile);
    const store = new Store(config.state.path);
    try {
        return await operation(new CloudCommandStore(store));
    }
    finally {
        store.close();
    }
}
