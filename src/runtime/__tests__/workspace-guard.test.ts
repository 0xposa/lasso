import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceGuard } from "../workspace-guard";

describe("WorkspaceGuard", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lasso-guard-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports no changes right after capture", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    const guard = await WorkspaceGuard.capture(dir);

    assert.equal(guard.fileCount, 1);
    assert.deepEqual(guard.diff(), []);

    await guard.dispose();
  });

  it("rejects a capture of a missing directory", async () => {
    await assert.rejects(() => WorkspaceGuard.capture(path.join(dir, "does-not-exist")));
  });

  it("diffs modified, created, and deleted files", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    fs.writeFileSync(path.join(dir, "gone.txt"), "bye");
    const guard = await WorkspaceGuard.capture(dir);

    fs.writeFileSync(path.join(dir, "a.txt"), "hello world");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "new.txt"), "fresh");
    fs.unlinkSync(path.join(dir, "gone.txt"));

    const changes = guard.diff();
    const byPath = new Map(changes.map((c) => [c.filePath, c]));

    assert.equal(changes.length, 3);

    const modified = byPath.get("a.txt")!;
    assert.equal(modified.operation, "modified");
    assert.equal(modified.oldContent, "hello");
    assert.equal(modified.newContent, "hello world");

    const created = byPath.get(path.join("sub", "new.txt"))!;
    assert.equal(created.operation, "created");
    assert.equal(created.newContent, "fresh");

    const deleted = byPath.get("gone.txt")!;
    assert.equal(deleted.operation, "deleted");
    assert.equal(deleted.oldContent, "bye");

    await guard.dispose();
  });

  it("restore() rolls the workspace back (review rejection)", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "original");
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep me");
    fs.writeFileSync(path.join(dir, "gone.txt"), "will be deleted");
    const guard = await WorkspaceGuard.capture(dir);

    fs.writeFileSync(path.join(dir, "a.txt"), "agent edit");
    fs.writeFileSync(path.join(dir, "created.txt"), "agent file");
    fs.unlinkSync(path.join(dir, "gone.txt"));

    assert.equal(guard.diff().length, 3);

    await guard.restore();

    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "original");
    assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "keep me");
    assert.equal(fs.readFileSync(path.join(dir, "gone.txt"), "utf8"), "will be deleted");
    assert.ok(!fs.existsSync(path.join(dir, "created.txt")));

    // Post-rollback the workspace matches capture again: nothing pending.
    assert.deepEqual(guard.diff(), []);
  });

  it("ignores default ignore dirs such as node_modules and .git", async () => {
    fs.writeFileSync(path.join(dir, "app.ts"), "code");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "dep");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref");

    const guard = await WorkspaceGuard.capture(dir);
    assert.equal(guard.fileCount, 1);

    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "changed");
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "changed");

    assert.deepEqual(guard.diff(), []);

    await guard.dispose();
  });

  it("keeps binary files restorable but excludes them from text diffs", async () => {
    const original = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x7f]);
    fs.writeFileSync(path.join(dir, "logo.bin"), original);
    const guard = await WorkspaceGuard.capture(dir);

    fs.writeFileSync(path.join(dir, "logo.bin"), Buffer.from([0x00, 0x99, 0x00]));

    const changes = guard.diff();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].operation, "modified");
    assert.equal(changes[0].binary, true);
    assert.equal(changes[0].oldContent, undefined);

    await guard.restore();
    assert.deepEqual(fs.readFileSync(path.join(dir, "logo.bin")), original);
  });

  it("restore() is single-use and dispose stays safe", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "one");
    const guard = await WorkspaceGuard.capture(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "two");

    await guard.restore();
    await guard.dispose();

    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one");
  });
});
