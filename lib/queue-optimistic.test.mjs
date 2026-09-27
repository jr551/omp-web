import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./queue-optimistic.ts");
}

const server = (steering = [], followUp = []) => ({ steering, followUp });

test("merges pending optimistic entries after the server's queue", async () => {
  const { mergeQueued } = await loadSubject();
  const pending = [
    { id: "1", kind: "steering", text: "steer me" },
    { id: "2", kind: "followUp", text: "then this" },
  ];
  assert.deepEqual(mergeQueued(server(), pending), {
    steering: ["steer me"],
    followUp: ["then this"],
  });
  assert.deepEqual(mergeQueued(server(["existing"]), pending), {
    steering: ["existing", "steer me"],
    followUp: ["then this"],
  });
});

test("merge tolerates a null server queue", async () => {
  const { mergeQueued } = await loadSubject();
  assert.deepEqual(mergeQueued(null, [{ id: "1", kind: "steering", text: "x" }]), {
    steering: ["x"],
    followUp: [],
  });
});

test("reconcile drops pending entries the server now reports", async () => {
  const { reconcilePending } = await loadSubject();
  const pending = [
    { id: "1", kind: "steering", text: "confirmed" },
    { id: "2", kind: "followUp", text: "still pending" },
  ];
  const remaining = reconcilePending(pending, server(["confirmed"]));
  assert.deepEqual(remaining, [{ id: "2", kind: "followUp", text: "still pending" }]);
});

test("reconcile matches duplicate texts one server slot at a time", async () => {
  const { reconcilePending } = await loadSubject();
  const pending = [
    { id: "1", kind: "steering", text: "dup" },
    { id: "2", kind: "steering", text: "dup" },
  ];
  // Server only reflects one copy so far — one optimistic entry remains.
  const remaining = reconcilePending(pending, server(["dup"]));
  assert.deepEqual(remaining, [{ id: "2", kind: "steering", text: "dup" }]);
});

test("add-then-reconcile shows the message instantly then dedupes on server truth", async () => {
  const { mergeQueued, reconcilePending } = await loadSubject();

  // Nothing queued yet.
  let serverQueue = server();
  let pending = [];

  // User queues a follow-up: it appears instantly (optimistic).
  const entry = { id: "temp-1", kind: "followUp", text: "do the thing" };
  pending = [...pending, entry];
  assert.deepEqual(mergeQueued(serverQueue, pending), {
    steering: [],
    followUp: ["do the thing"],
  });

  // Server confirms via queue_update: reconcile drops the optimistic copy,
  // and the merged view shows exactly one entry (no duplication).
  serverQueue = server([], ["do the thing"]);
  pending = reconcilePending(pending, serverQueue);
  assert.deepEqual(pending, []);
  assert.deepEqual(mergeQueued(serverQueue, pending), {
    steering: [],
    followUp: ["do the thing"],
  });
});

test("rollback: a failed send removes the optimistic entry by id", async () => {
  const { mergeQueued } = await loadSubject();
  const entry = { id: "temp-9", kind: "steering", text: "oops" };
  let pending = [entry];
  assert.deepEqual(mergeQueued(server(), pending).steering, ["oops"]);
  // On network failure the handler removes the entry by id.
  pending = pending.filter((e) => e.id !== "temp-9");
  assert.deepEqual(mergeQueued(server(), pending), { steering: [], followUp: [] });
});

test("dropOneQueued prefers a server slot when the text matches", async () => {
  const { dropOneQueued } = await loadSubject();
  const result = dropOneQueued(server(["steer me"], ["follow up"]), [], "steer me");
  assert.deepEqual(result.server, { steering: [], followUp: ["follow up"] });
  assert.deepEqual(result.pending, []);
});

test("dropOneQueued falls back to a pending optimistic entry", async () => {
  const { dropOneQueued } = await loadSubject();
  const pending = [
    { id: "1", kind: "followUp", text: "queued once" },
    { id: "2", kind: "steering", text: "other" },
  ];
  const result = dropOneQueued(server(), pending, "queued once");
  assert.deepEqual(result.server, { steering: [], followUp: [] });
  assert.deepEqual(result.pending, [{ id: "2", kind: "steering", text: "other" }]);
});

test("dropOneQueued matches on trimmed text", async () => {
  const { dropOneQueued } = await loadSubject();
  const result = dropOneQueued(server(["  spaced  "]), [], "spaced");
  assert.deepEqual(result.server, { steering: [], followUp: [] });
});

test("dropOneQueued is a no-op when nothing matches", async () => {
  const { dropOneQueued } = await loadSubject();
  const pending = [{ id: "1", kind: "steering", text: "keep me" }];
  const result = dropOneQueued(server(["also keep"]), pending, "not here");
  assert.deepEqual(result.server, { steering: ["also keep"], followUp: [] });
  assert.deepEqual(result.pending, pending);
});

test("dropOneQueued removes duplicate texts one delivery at a time", async () => {
  const { dropOneQueued } = await loadSubject();
  let state = { server: server(["dup", "dup"]), pending: [] };
  state = dropOneQueued(state.server, state.pending, "dup");
  assert.deepEqual(state.server, { steering: ["dup"], followUp: [] });
  state = dropOneQueued(state.server, state.pending, "dup");
  assert.deepEqual(state.server, { steering: [], followUp: [] });
  // A third delivery with no queue left is harmless.
  state = dropOneQueued(state.server, state.pending, "dup");
  assert.deepEqual(state.server, { steering: [], followUp: [] });
});
