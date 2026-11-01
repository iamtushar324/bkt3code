# Native image execution boundary

The weekly image consumer needs facts from the application that owns the native tool record.
A model-provided thread, run, hostname, UID or JSON receipt cannot establish those facts. An MCP
provider credential is also insufficient by itself: it survives between turns and background work
can outlive the turn that started it.

`NativeImageExecution` is an optional internal service. The default server composition does not
install it, expose an export tool or register a Python runtime port. Its presence in source does
not qualify a weekly executor or enable a collector.

## Two different session identities

The provider-session manager sees both identities at the real `startTurn` boundary:

- The MCP credential ID in `mcpCredentialIdByThread` is the identity authenticated by MCP.
- The runtime object is the actual provider process generation. A replacement process can reuse
  the same logical provider session ID, so that ID alone cannot fence a delayed callback.

The optional execution hook records the actual `startTurn.input.runId`, the credential ID and the
runtime object together. It never queries for the latest run. A terminal callback removes only
its own lease; stopping an old process cannot revoke a replacement process's lease. A bound port
checks that exact lease before and after each asynchronous operation.

Revocation also emits a code-owned abort signal. The private channel closes immediately and
destroys its owned pipe, including while its reader is idle. A dispatched operation can still
finish; its late result is discarded. The future worker launcher must use the same signal and
reconcile any dispatched export through the existing journal rather than retrying it.
Every revocation ends the pipe operation with the same fixed closed-channel error. An owned
adapter must settle pending reads and write callbacks when destroyed; closing only its read side
can leave the worker waiting for a write that will never complete.

The start wrapper retains its actual runtime; a later session-map lookup cannot select a
replacement runtime for the old start. The same entry supplies its credential. A code-owned
predicate checks both identities synchronously when the lease is published, so a suspension
between selection and publication cannot revive a stopped runtime or overwrite its replacement.

The host facts come from `HostProcess` and the actual HTTP listener, independently of the MCP
request origin. The measured consumer permits Darwin user `beknown` and loopback port `13773`.
Wildcard IPv4 and IPv6 listeners are refused, even if they also accept loopback connections.
Another listener or host must fail rather than reuse those measured assumptions.

## A private worker channel is not another MCP client

The proposed worker transport uses an inherited private Unix-stream descriptor. The application
binds the port before attaching the descriptor. The child must independently verify its socket
peer, parent process and fixed application listener before accepting the execution facts. A plain
JSON frame, an environment variable or an arbitrary descriptor does not establish application
ownership. Worker-entry/source pins and the original weekly claim remain separate prerequisites;
the protocol does not transfer or replace a claim. The worker must reconstruct the real mode/store
and recheck the original claim token, epoch and open action through the existing validators. The
durable UI lock holder has a separate PID; it must not be replaced with the child worker's PID.

The protocol has one outstanding request, strictly increasing IDs and two operations: execution
facts, or a call to the existing native-item reader or asset-URL issuer. The bound port restricts
both operations to one exact native image in the current turn. It validates the strong completed
Chrome source before permitting one asset mint. An uncertain mint is not retried. The existing
Python consumer must still verify its exact producer, byte proof, timing, weekly gates and journal.

Frames are UTF-8 NDJSON. Requests are bounded to 16 KiB and responses to 50 MiB. Malformed,
pipelined, partial and replayed frames close the channel. Errors are fixed messages: no original
exception, signed asset path or native output is included. The private pipe must never be
connected to agent-visible stdout, stderr or a public endpoint.

This boundary supplies neither a native capture nor a Google operation. Production construction,
the fixed worker entry, source pin, Python port registration and full runtime qualification must
exist before the connection can be used. Collector switches, activation records and human write
approvals retain their own authority.
