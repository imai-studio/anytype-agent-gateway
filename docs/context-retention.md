# Workspace context retention

Knot writes attachment copies under `<runtime.defaultProject>/.aag/attachments/` and,
with `context.promptMode: workspace`, writes JSON context under `.aag/context/`.
An attachment's message/file pair and a context's native session key determine its
filename. Repeating the same turn overwrites those files; distinct messages and
sessions add files. History and reply-ancestry media remain available through the
context bundle even when the compact prompt only lists the current turn's media.

Configure cleanup with:

```yaml
context:
  retention:
    maxAgeDays: 30
    maxBytes: 1073741824 # 1 GiB of managed files
```

These are the defaults. Both values must be positive integers. Knot sweeps at
startup and every six hours. It removes old inactive context and unreferenced
attachments, and evicts the oldest inactive session context when managed files
exceed the byte target. Empty attachment directories are removed only after their
managed files have been deleted.

Active and resetting session bindings protect their context and all attachments
recorded for that session, including media from earlier turns. Preparing a turn
also holds cleanup until the session binding and its references are recorded.
A retained context never loses its recorded attachment references during eviction.
This applies to media in both full and workspace prompt modes. An active or
resumable session's working set can exceed the byte target; cleanup preserves the
session rather than removing files it may still need. Resetting or retiring a
binding makes the old session eligible for retention. The limits are cleanup
targets, not a hard filesystem quota or a limit on one attachment download.

A private registry next to `state.path` records only the hash-named files Knot
writes after this feature is installed. Cleanup verifies each recorded file's
regular-file type, inode, device, size and modification time, and refuses symlinked
parents. It does not recursively remove directories. Files from earlier versions,
unregistered operator files, files modified or replaced outside Knot, and files
under symlinked directories are left untouched and are outside the byte target.
Inspect those files separately before operator cleanup. Reusing a legacy filename
through a normal turn registers the newly written copy.

Writes also refuse symlinked managed directories, including `.aag` itself,
`.aag/context`, `.aag/attachments`, and each attachment subdirectory. An affected
attachment is reported unavailable; a blocked context-directory write prevents
workspace prompt preparation. To repair this, stop the agent, inspect and preserve
the symlink target's data, and replace the symlink with a real directory inside
the configured workspace. If the target is the intended workspace, configure that
workspace explicitly instead. Knot will not traverse the link or move its target
data automatically.

Keep the registry with the state database when backing up or moving an agent.
Missing registry data safely leaves existing files unmanaged. The registry and
path checks protect against accidental deletion; they are not an isolation
boundary against another process with the same OS user's access to the workspace
and state directory.

Registry maintenance is best effort. If another process holds its lock, Knot skips
that update immediately. Unreadable, nonregular or corrupt registry data also
causes maintenance to skip, before deleting any managed files. Knot preserves the
registry evidence instead of replacing it with an empty map. These registry
failures do not prevent attachment delivery or prompt preparation when the
workspace itself is writable.

For a damaged registry, preserve a copy and restore a known-good backup after
stopping the agent. Do not replace it with an empty map to force cleanup. The next
turn or scheduled sweep retries maintenance once state access is restored. Files
written during skipped registration remain unmanaged until a normal turn writes
and registers them again; restoring a backup does not automatically claim them.

Runtime route-management changes preserve YAML comments and untouched formatting
through document-node edits. When changing an anchored policy, Knot detaches alias
consumers that must keep their old value. Configuration writes stay atomic and
private (`0600`), including when the previous file had broader permissions.
