import { AgentController, messageFingerprint, } from "./controller.js";
import { DiscussionAnytypePort } from "./discussions.js";
import { WorkflowObserver } from "./automation/observer.js";
import { WorkflowRunner } from "./automation/runner.js";
import { CloudClient } from "./cloud-client.js";
import { loadCloudConfig, resolveCloudPaths } from "./cloud-config.js";
import { AnytypeCloudCommandExecutor, CloudWorkflowExtension } from "./cloud-workflow.js";
import { decideWake, mergeWakeOverride, sameIdentity } from "./wake.js";
import { principalAuditFields, principalFromMessage, principalFromParticipantId, } from "./principal.js";
const INTERRUPTED_RUN_RECOVERY_GRACE_MS = 60 * 60 * 1000;
const DIRECT_MESSAGE_DISCOVERY_MARKER = "system:aag:direct-message-discovery";
const directMessageSpaceMarker = (spaceId) => `system:aag:direct-message-space:${spaceId}`;
const directMessageBootstrapMarker = (identity) => `system:aag:direct-message-bootstrap:${identity}`;
export class Gateway {
    anytype;
    runtime;
    config;
    store;
    discussions;
    log;
    enrollChat;
    abort = new AbortController();
    routeIds = new Set();
    tasks = new Set();
    auxiliaryTasks = new Set();
    controller;
    discussionAnytype;
    terminal;
    pruneTimer;
    drainOnStop = false;
    reportedUnknownSpaceKinds = new Set();
    initialDirectMessageScanComplete = false;
    directMessageBootstrapFailures = new Map();
    directMessageMembership = new Map();
    resolveTerminal;
    rejectTerminal;
    constructor(anytype, runtime, config, store, discussions, log, managementCommand, enrollChat) {
        this.anytype = anytype;
        this.runtime = runtime;
        this.config = config;
        this.store = store;
        this.discussions = discussions;
        this.log = log;
        this.enrollChat = enrollChat;
        this.discussionAnytype = new DiscussionAnytypePort(anytype, discussions);
        this.controller = new AgentController(anytype, runtime, config, store, log, this.discussionAnytype, managementCommand);
        this.terminal = new Promise((resolve, reject) => {
            this.resolveTerminal = resolve;
            this.rejectTerminal = reject;
        });
        void this.terminal.catch(() => undefined);
    }
    async start() {
        try {
            this.store.prune(Date.now() - 30 * 24 * 60 * 60 * 1000);
            this.pruneTimer = setInterval(() => {
                try {
                    this.store.prune(Date.now() - 30 * 24 * 60 * 60 * 1000);
                }
                catch (error) {
                    this.log("state_prune_failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }, 6 * 60 * 60 * 1000);
            this.pruneTimer.unref?.();
            for (const configuredSpace of this.config.spaces) {
                if (!configuredSpace.id && !configuredSpace.name)
                    throw new Error("A space needs id or name after its invite has been joined");
                const space = await this.anytype.resolveSpace({
                    ...(configuredSpace.id ? { id: configuredSpace.id } : {}),
                    ...(configuredSpace.name ? { name: configuredSpace.name } : {}),
                });
                for (const configuredChat of configuredSpace.chats) {
                    const chat = await this.anytype.resolveChat(space.id, {
                        ...(configuredChat.id ? { id: configuredChat.id } : {}),
                        ...(configuredChat.name ? { name: configuredChat.name } : {}),
                    });
                    const override = configuredSpace.wakeOverrides.find((item) => item.kind === "chat" && item.id === chat.id);
                    this.addRoute({
                        conversation: {
                            routeId: `chat:${space.id}:${chat.id}`,
                            spaceId: space.id,
                            chatId: chat.id,
                            kind: "chat",
                            selfParticipantId: configuredSpace.participantId ?? this.config.agent.participantId,
                        },
                        wake: override?.wake ?? configuredChat.wake,
                    });
                }
                if (configuredSpace.chatDiscovery.enabled)
                    this.track(this.discoverChats(space.id, space.name, configuredSpace.chatDiscovery, configuredSpace.participantId ?? this.config.agent.participantId, configuredSpace.wakeOverrides));
                if (configuredSpace.comments.mode !== "disabled")
                    this.track(this.discoverDiscussions(space.id, configuredSpace.comments, configuredSpace.participantId ?? this.config.agent.participantId, configuredSpace.wakeOverrides));
            }
            if (this.config.directMessages.enabled)
                this.track(this.discoverDirectMessages(this.config.directMessages));
            if (!this.tasks.size)
                throw new Error("Configuration produced no chat or discussion routes");
            if (this.config.automation.enabled && this.config.automation.execution) {
                const extensions = [];
                if (this.config.cloudCommands.enabled) {
                    const paths = resolveCloudPaths({
                        ...(this.config.cloudCommands.cloudConfigFile
                            ? { configFile: this.config.cloudCommands.cloudConfigFile }
                            : {}),
                    });
                    const cloudConfig = await loadCloudConfig(paths);
                    if (!cloudConfig?.paired)
                        throw new Error("cloudCommands requires an approved Knot Cloud pairing");
                    const cloud = new CloudClient(cloudConfig);
                    const executor = new AnytypeCloudCommandExecutor(this.anytype, cloud, cloudConfig, this.config.agent.participantId);
                    extensions.push(new CloudWorkflowExtension(this.store, cloud, executor, this.config.cloudCommands, this.anytype, this.log));
                }
                this.trackAuxiliary(new WorkflowRunner(this.store, this.config.automation, this.log, undefined, Date.now, undefined, extensions).run(this.abort.signal), "workflow_runner_stopped");
            }
            if (this.config.automation.enabled && this.config.automation.observation)
                this.trackAuxiliary(new WorkflowObserver(this.anytype, this.store, this.config.automation, this.log).run(this.abort.signal), "workflow_observer_stopped");
            await this.terminal;
        }
        finally {
            this.abort.abort();
            if (this.pruneTimer)
                clearInterval(this.pruneTimer);
            this.pruneTimer = undefined;
            await Promise.allSettled([...this.tasks, ...this.auxiliaryTasks]);
            await this.controller.stop({ drain: this.drainOnStop });
        }
    }
    stop(options = {}) {
        this.drainOnStop ||= options.drain ?? false;
        this.abort.abort();
        this.resolveTerminal();
    }
    addRoute(route) {
        if (this.routeIds.has(route.conversation.routeId))
            return;
        this.routeIds.add(route.conversation.routeId);
        this.track(this.runRoute(route));
    }
    track(task) {
        this.tasks.add(task);
        void task.then(() => this.tasks.delete(task), (error) => {
            this.tasks.delete(task);
            if (!this.abort.signal.aborted) {
                this.abort.abort(error);
                this.rejectTerminal(error);
            }
        });
    }
    trackAuxiliary(task, failureEvent) {
        const guarded = task.catch(() => {
            if (!this.abort.signal.aborted)
                this.log(failureEvent, { errorCode: "unexpected_failure" });
        });
        this.auxiliaryTasks.add(guarded);
        void guarded.finally(() => this.auxiliaryTasks.delete(guarded));
    }
    async runRoute(route) {
        const { conversation } = route;
        const anytype = this.port(conversation);
        let delay = 500;
        let reconciledInterruptedRuns = false;
        while (!this.abort.signal.aborted) {
            const attemptStarted = Date.now();
            try {
                if (!this.store.isInitialized(conversation.routeId)) {
                    const recent = await anytype.listMessages(conversation.spaceId, conversation.chatId, 100);
                    const baseline = route.baselineExisting === false ? recent.slice(0, -20) : recent;
                    for (const message of baseline)
                        this.store.markHandled(conversation.routeId, message.id, message.modified_at ?? message.created_at, messageFingerprint(message));
                    this.store.initialize(conversation.routeId, baseline.at(-1)?.order_id);
                    this.log(route.baselineExisting === false ? "route_recent_catchup" : "route_baselined", {
                        routeId: conversation.routeId,
                        messages: recent.length,
                        pending: recent.length - baseline.length,
                    });
                }
                await this.controller.restoreObserversForRoute(conversation);
                if (!reconciledInterruptedRuns) {
                    await this.reconcileInterruptedRuns(conversation);
                    reconciledInterruptedRuns = true;
                }
                let cursor = await this.catchUp(anytype, route, this.store.cursor(conversation.routeId));
                this.log("route_connecting", { routeId: conversation.routeId });
                const eventStream = anytype.stream(conversation.spaceId, conversation.chatId, this.abort.signal);
                const stream = eventStream[Symbol.asyncIterator]();
                let next = stream.next();
                try {
                    while (!this.abort.signal.aborted) {
                        const outcome = await raceWithReconciliation(next, 10_000, this.abort.signal);
                        if (outcome.kind === "reconcile") {
                            cursor = await this.catchUp(anytype, route, cursor);
                            continue;
                        }
                        if (outcome.result.done)
                            break;
                        next = stream.next();
                        const event = outcome.result.value;
                        const message = event.payload?.message;
                        if ((event.type === "message_added" || event.type === "message_updated") && message) {
                            // Anytype order IDs are opaque fractional indexes, not strings with a
                            // meaningful lexical ordering. Exact message-version dedupe belongs
                            // in the controller; the periodic API reconciliation owns the cursor.
                            await this.processMessage(route, message);
                        }
                    }
                }
                finally {
                    await stream.return?.().catch(() => undefined);
                }
                if (!this.abort.signal.aborted)
                    throw new Error("event stream ended");
            }
            catch (error) {
                if (this.abort.signal.aborted)
                    break;
                if (Date.now() - attemptStarted >= 30_000)
                    delay = 500;
                this.log("route_disconnected", {
                    routeId: conversation.routeId,
                    error: error instanceof Error ? error.message : String(error),
                    retryMs: delay,
                });
                await wait(delay, this.abort.signal);
                delay = Math.min(delay * 2, 30_000);
            }
        }
    }
    async catchUp(anytype, route, initialCursor) {
        const { conversation } = route;
        let cursor = initialCursor;
        for (;;) {
            const previousCursor = cursor;
            const messages = await anytype.listMessages(conversation.spaceId, conversation.chatId, 100, cursor);
            for (const message of messages) {
                await this.processMessage(route, message);
                if (message.order_id) {
                    cursor = message.order_id;
                    this.store.updateCursor(conversation.routeId, message.order_id);
                }
            }
            if (!messages.length || cursor === previousCursor)
                return cursor;
        }
    }
    async processMessage(route, message) {
        const effectiveWake = mergeWakeOverride(route.wake, this.store.wakeOverride(route.conversation.routeId));
        if (route.autoEnrollment && !route.autoEnrollment.complete) {
            const enrollment = this.maybeAutoEnroll(route, effectiveWake, message);
            await Promise.race([enrollment, wait(1_000, this.abort.signal).catch(() => undefined)]);
        }
        await this.controller.process(route.conversation, effectiveWake, message, {
            wakeIsEffective: true,
        });
    }
    async maybeAutoEnroll(route, wake, message) {
        const enrollment = route.autoEnrollment;
        if (!enrollment || enrollment.complete || !this.enrollChat)
            return;
        if (enrollment.pending)
            return enrollment.pending;
        if (Date.now() < enrollment.nextAttemptAt)
            return;
        const decision = decideWake(message, wake, this.config, {
            replyToAgent: false,
            ...(route.conversation.selfParticipantId
                ? { selfParticipantId: route.conversation.selfParticipantId }
                : {}),
        });
        if (decision.isAgent ||
            !decision.directMention ||
            !decision.wake ||
            wake.allowedUsers.includes("*"))
            return;
        enrollment.pending = (async () => {
            try {
                const result = await this.enrollChat(route.conversation.spaceId, route.conversation.spaceName ?? "", route.conversation.chatId, enrollment.chatName, wake);
                enrollment.complete = true;
                this.log(result === "enrolled" ? "chat_auto_enrolled" : "chat_auto_enrollment_complete", {
                    routeId: route.conversation.routeId,
                    ...principalAuditFields(principalFromMessage(message)),
                    result,
                });
            }
            catch (error) {
                enrollment.failures += 1;
                enrollment.nextAttemptAt = Date.now() + Math.min(2 ** enrollment.failures * 1_000, 60_000);
                this.log("chat_auto_enrollment_failed", {
                    routeId: route.conversation.routeId,
                    ...principalAuditFields(principalFromMessage(message)),
                    retryAt: enrollment.nextAttemptAt,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            finally {
                delete enrollment.pending;
            }
        })();
        return enrollment.pending;
    }
    async discoverChats(spaceId, spaceName, discovery, selfParticipantId, overrides) {
        let firstPass = true;
        while (!this.abort.signal.aborted) {
            try {
                const chats = await this.anytype.listChats(spaceId);
                for (const chat of chats) {
                    this.addRoute({
                        conversation: {
                            routeId: `chat:${spaceId}:${chat.id}`,
                            spaceId,
                            chatId: chat.id,
                            kind: "chat",
                            spaceName,
                            selfParticipantId,
                        },
                        wake: overrides.find((item) => item.kind === "chat" && item.id === chat.id)?.wake ??
                            discovery.wake,
                        baselineExisting: firstPass,
                        ...(discovery.autoEnroll
                            ? {
                                autoEnrollment: {
                                    chatName: chat.name,
                                    complete: false,
                                    failures: 0,
                                    nextAttemptAt: 0,
                                },
                            }
                            : {}),
                    });
                }
                this.log("chat_discovery_complete", { spaceId, chats: chats.length });
            }
            catch (error) {
                if (firstPass)
                    throw error;
                this.log("chat_discovery_failed", {
                    spaceId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            firstPass = false;
            await wait(discovery.discoveryIntervalSeconds * 1000, this.abort.signal).catch(() => undefined);
        }
    }
    async discoverDirectMessages(discovery) {
        while (!this.abort.signal.aborted) {
            try {
                const allSpaces = await this.anytype.listSpaces();
                const knownKinds = new Set([
                    "anytype.space",
                    "anytype.chatspace",
                    "anytype.onetoone",
                    "anytype.techspace",
                ]);
                const unknownKinds = [
                    ...new Set(allSpaces
                        .map((space) => space.object ?? "missing")
                        .filter((kind) => !knownKinds.has(kind))),
                ];
                const newlyObservedKinds = unknownKinds.filter((kind) => !this.reportedUnknownSpaceKinds.has(kind));
                if (newlyObservedKinds.length) {
                    for (const kind of newlyObservedKinds)
                        this.reportedUnknownSpaceKinds.add(kind);
                    this.log("direct_message_space_kind_unsupported", { observed: newlyObservedKinds });
                }
                const spaces = allSpaces.filter((space) => space.object === "anytype.onetoone");
                if (!this.initialDirectMessageScanComplete) {
                    if (!this.store.isInitialized(DIRECT_MESSAGE_DISCOVERY_MARKER)) {
                        for (const space of spaces)
                            this.store.initialize(directMessageSpaceMarker(space.id));
                        this.store.initialize(DIRECT_MESSAGE_DISCOVERY_MARKER);
                    }
                    this.initialDirectMessageScanComplete = true;
                }
                let chatsDiscovered = 0;
                const authorizedPeerIdentities = new Set();
                let membershipScanClean = true;
                for (const space of spaces) {
                    try {
                        const now = Date.now();
                        let membership = this.directMessageMembership.get(space.id);
                        if (membership?.authorized && membership.peerIdentity)
                            authorizedPeerIdentities.add(membership.peerIdentity);
                        const refreshAfter = membership?.authorized || membership?.reason === "unauthorized-peer"
                            ? 5 * 60 * 1000
                            : discovery.discoveryIntervalSeconds * 1000;
                        if (!membership || now - membership.checkedAt >= refreshAfter) {
                            const members = (await this.anytype.listMembers(space.id)).filter((member) => member.status === "active");
                            const self = members.find((member) => sameIdentity(member.identity ?? member.id, this.config.agent.participantId));
                            const peers = members.filter((member) => !sameIdentity(member.identity ?? member.id, this.config.agent.participantId));
                            const authorizedPeer = peers.length === 1 &&
                                discovery.wake.allowedUsers.some((allowed) => sameIdentity(peers[0].identity ?? peers[0].id, allowed))
                                ? peers[0]
                                : undefined;
                            const reason = !self
                                ? "self-member-not-found"
                                : peers.length !== 1
                                    ? "not-one-to-one"
                                    : authorizedPeer
                                        ? undefined
                                        : "unauthorized-peer";
                            const previousReason = membership?.reason;
                            membership = {
                                checkedAt: now,
                                authorized: Boolean(self && authorizedPeer),
                                ...(reason ? { reason } : {}),
                                ...(self ? { selfParticipantId: self.id } : {}),
                                ...(authorizedPeer ? { peerName: authorizedPeer.name } : {}),
                                ...(authorizedPeer
                                    ? { peerIdentity: authorizedPeer.identity ?? authorizedPeer.id }
                                    : {}),
                            };
                            this.directMessageMembership.set(space.id, membership);
                            if (reason && reason !== previousReason)
                                this.log("direct_message_ignored", { spaceId: space.id, reason });
                        }
                        if (!membership.authorized || !membership.selfParticipantId)
                            continue;
                        if (membership.peerIdentity)
                            authorizedPeerIdentities.add(membership.peerIdentity);
                        const chats = await this.anytype.listChats(space.id);
                        for (const chat of chats) {
                            chatsDiscovered += 1;
                            this.addRoute({
                                conversation: {
                                    routeId: `chat:${space.id}:${chat.id}`,
                                    spaceId: space.id,
                                    chatId: chat.id,
                                    kind: "chat",
                                    spaceName: membership.peerName || space.name,
                                    selfParticipantId: membership.selfParticipantId,
                                    managementEnabled: false,
                                },
                                wake: discovery.wake,
                                baselineExisting: this.store.isInitialized(directMessageSpaceMarker(space.id)),
                            });
                        }
                    }
                    catch (error) {
                        membershipScanClean = false;
                        this.log("direct_message_space_discovery_failed", {
                            spaceId: space.id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                if (discovery.createMissing && membershipScanClean) {
                    for (const allowed of discovery.wake.allowedUsers) {
                        if (this.abort.signal.aborted)
                            break;
                        const identity = allowed.split("_").at(-1);
                        const retry = this.directMessageBootstrapFailures.get(identity);
                        if ([...authorizedPeerIdentities].some((observed) => sameIdentity(observed, identity)) ||
                            this.store.isInitialized(directMessageBootstrapMarker(identity)) ||
                            (retry && retry.nextAttemptAt > Date.now()))
                            continue;
                        try {
                            const created = await this.discussions.ensureDirectMessage(identity, this.abort.signal);
                            const members = (await this.anytype.listMembers(created.spaceId)).filter((member) => member.status === "active");
                            const self = members.find((member) => sameIdentity(member.identity ?? member.id, this.config.agent.participantId));
                            const peer = members.find((member) => sameIdentity(member.identity ?? member.id, identity));
                            if (!self || !peer || members.length !== 2)
                                throw new Error("Created direct message did not expose the expected two members");
                            this.directMessageMembership.set(created.spaceId, {
                                checkedAt: Date.now(),
                                authorized: true,
                                selfParticipantId: self.id,
                                peerName: peer.name,
                                peerIdentity: peer.identity ?? peer.id,
                            });
                            authorizedPeerIdentities.add(peer.identity ?? peer.id);
                            this.addRoute({
                                conversation: {
                                    routeId: `chat:${created.spaceId}:${created.chatId}`,
                                    spaceId: created.spaceId,
                                    chatId: created.chatId,
                                    kind: "chat",
                                    spaceName: peer.name,
                                    selfParticipantId: self.id,
                                    managementEnabled: false,
                                },
                                wake: discovery.wake,
                                baselineExisting: false,
                            });
                            this.store.initialize(directMessageBootstrapMarker(identity));
                            this.directMessageBootstrapFailures.delete(identity);
                            this.log("direct_message_created", {
                                ...principalAuditFields(principalFromParticipantId(identity)),
                                ...created,
                            });
                        }
                        catch (error) {
                            if (this.abort.signal.aborted)
                                break;
                            const failures = (retry?.failures ?? 0) + 1;
                            const retryInSeconds = Math.min(3600, 30 * 2 ** Math.min(failures - 1, 7));
                            this.directMessageBootstrapFailures.set(identity, {
                                failures,
                                nextAttemptAt: Date.now() + retryInSeconds * 1000,
                            });
                            this.log("direct_message_create_failed", {
                                ...principalAuditFields(principalFromParticipantId(identity)),
                                failures,
                                retryInSeconds,
                                error: error instanceof Error ? error.message : String(error),
                            });
                        }
                    }
                }
                this.log("direct_message_discovery_complete", {
                    spaces: spaces.length,
                    chats: chatsDiscovered,
                });
            }
            catch (error) {
                this.log("direct_message_discovery_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            await wait(discovery.discoveryIntervalSeconds * 1000, this.abort.signal).catch(() => undefined);
        }
    }
    async reconcileInterruptedRuns(conversation) {
        const anytype = this.port(conversation);
        for (const run of this.store.runningRuns(conversation.routeId)) {
            const binding = this.store.sessionBinding(run.threadKey);
            if (this.runtime.capabilities.sessionObservation &&
                this.runtime.observeSession &&
                binding?.state === "active" &&
                Date.now() - run.startedAt < INTERRUPTED_RUN_RECOVERY_GRACE_MS) {
                this.log("run_reconcile_deferred", {
                    routeId: conversation.routeId,
                    runId: run.id,
                    threadKey: run.threadKey,
                });
                continue;
            }
            try {
                await anytype
                    .ensureReaction(conversation.spaceId, conversation.chatId, run.triggerId, this.config.responses.workingReaction, false, conversation.selfParticipantId ?? this.config.agent.participantId)
                    .catch(() => undefined);
                const response = await anytype
                    .getMessage(conversation.spaceId, conversation.chatId, run.responseId)
                    .catch(() => undefined);
                const visible = response?.content?.text?.trim();
                const text = visible && visible !== this.config.responses.workingText
                    ? `${visible}\n\nAgent run interrupted before completion.`
                    : "Agent run interrupted before completion.";
                await anytype
                    .editMessage(conversation.spaceId, conversation.chatId, run.responseId, text)
                    .catch((error) => {
                    this.log("run_reconcile_projection_failed", {
                        routeId: conversation.routeId,
                        runId: run.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            }
            finally {
                const cycle = this.store.openOutputCycle(run.threadKey);
                if (cycle)
                    this.store.finishOutputCycle(cycle.id, "failed");
                this.store.finishRun(run.id, "failed");
                this.log("run_reconciled", { routeId: conversation.routeId, runId: run.id });
            }
        }
    }
    async discoverDiscussions(spaceId, comments, selfParticipantId, overrides) {
        let firstPass = true;
        while (!this.abort.signal.aborted) {
            try {
                const known = this.store.knownDiscussionObjectIds(spaceId);
                const objects = [];
                const seenObjects = new Set();
                let offset = 0;
                let exhausted = false;
                for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
                    const page = await this.anytype.searchObjects(spaceId, offset, 250);
                    if (!page.length) {
                        exhausted = true;
                        break;
                    }
                    const unique = page.filter((object) => !seenObjects.has(object.id));
                    for (const object of unique) {
                        seenObjects.add(object.id);
                        objects.push(object);
                    }
                    offset += page.length;
                    if (!unique.length) {
                        exhausted = true;
                        break;
                    }
                }
                if (!exhausted)
                    throw new Error(`Discussion discovery exceeded 100 object-search pages in space ${spaceId}`);
                const candidates = objects.filter((object) => !known.has(object.id) &&
                    (comments.mode === "all" ||
                        !comments.includeObjectTypes.length ||
                        Boolean(object.type && comments.includeObjectTypes.includes(object.type))) &&
                    !(object.type && comments.excludeObjectTypes.includes(object.type)));
                for (let index = 0; index < candidates.length; index += 10) {
                    const batch = candidates.slice(index, index + 10);
                    let resolved;
                    try {
                        resolved = await this.discussions.resolve(spaceId, batch, comments.createMissing);
                    }
                    catch (error) {
                        this.log("discussion_resolution_batch_failed", {
                            spaceId,
                            objectIds: batch.map((item) => item.id),
                            error: error instanceof Error ? error.message : String(error),
                        });
                        continue;
                    }
                    for (const item of resolved) {
                        if (item.error) {
                            this.log("discussion_resolution_failed", {
                                spaceId,
                                objectId: item.objectId,
                                error: item.error,
                            });
                            continue;
                        }
                        if (!item.discussionId)
                            continue;
                        const object = batch.find((candidate) => candidate.id === item.objectId);
                        this.store.cacheDiscussion({
                            spaceId,
                            objectId: item.objectId,
                            discussionId: item.discussionId,
                            ...(object?.name ? { objectName: object.name } : {}),
                            ...(object?.type ? { objectType: object.type } : {}),
                        });
                    }
                }
                for (const item of this.store.listDiscussions(spaceId)) {
                    this.addRoute({
                        conversation: {
                            routeId: `discussion:${spaceId}:${item.discussionId}`,
                            spaceId,
                            chatId: item.discussionId,
                            kind: "discussion",
                            objectId: item.objectId,
                            selfParticipantId,
                            ...(item.objectName ? { objectName: item.objectName } : {}),
                        },
                        wake: overrides.find((override) => override.kind === "discussion" && override.id === item.discussionId)?.wake ?? comments.wake,
                        baselineExisting: firstPass,
                    });
                }
                this.log("discussion_discovery_complete", {
                    spaceId,
                    objects: objects.length,
                    discussions: this.store.listDiscussions(spaceId).length,
                });
            }
            catch (error) {
                if (firstPass)
                    throw error;
                this.log("discussion_discovery_failed", {
                    spaceId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            firstPass = false;
            await wait(comments.discoveryIntervalSeconds * 1000, this.abort.signal).catch(() => undefined);
        }
    }
    port(conversation) {
        return conversation.kind === "discussion" ? this.discussionAnytype : this.anytype;
    }
}
function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted)
            return reject(signal.reason);
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}
async function raceWithReconciliation(next, milliseconds, signal) {
    let timer;
    let abort;
    const reconcile = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "reconcile" }), milliseconds);
    });
    const aborted = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error("Anytype route stopped"));
        if (signal.aborted)
            abort();
        else
            signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([
            next.then((result) => ({ kind: "event", result })),
            reconcile,
            aborted,
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (abort)
            signal.removeEventListener("abort", abort);
    }
}
