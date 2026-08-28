import type { AgentConfig } from "./config.js";
import { runProcess } from "./process.js";

export type DiscussionResolution = { objectId: string; discussionId?: string; error?: string };

export class HeartDiscussionAdapter {
  constructor(private readonly config: AgentConfig) {}

  async resolve(spaceId: string, objects: Array<{ id: string }>, createMissing: boolean): Promise<DiscussionResolution[]> {
    if (!objects.length) return [];
    const { command, grpcAddress } = this.config.anytype.heartAdapter;
    const args = ["resolve", "--space-id", spaceId, "--grpc-address", grpcAddress, ...(createMissing ? ["--create-missing"] : [])];
    if (this.config.anytype.cli.configPath) args.push("--config", this.config.anytype.cli.configPath);
    const { stdout } = await runProcess(command, args, { stdin: `${JSON.stringify({ objectIds: objects.map(object => object.id) })}\n`, timeoutMs: Math.max(30_000, objects.length * 12_000) });
    const result = JSON.parse(stdout) as { discussions: DiscussionResolution[] };
    return result.discussions;
  }
}
