import { runProcess } from "./process.js";
export class HeartDiscussionAdapter {
    config;
    constructor(config) {
        this.config = config;
    }
    async resolve(spaceId, objects, createMissing) {
        if (!objects.length)
            return [];
        const { command, grpcAddress } = this.config.anytype.heartAdapter;
        const args = ["resolve", "--space-id", spaceId, "--grpc-address", grpcAddress, ...(createMissing ? ["--create-missing"] : [])];
        if (this.config.anytype.cli.configPath)
            args.push("--config", this.config.anytype.cli.configPath);
        const { stdout } = await runProcess(command, args, { stdin: `${JSON.stringify({ objectIds: objects.map(object => object.id) })}\n`, timeoutMs: Math.max(30_000, objects.length * 12_000) });
        const result = JSON.parse(stdout);
        return result.discussions;
    }
}
