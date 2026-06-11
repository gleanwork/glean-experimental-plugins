import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveFileArgs, FileArgsError } from "../src/tools/run-tool.js";

describe("resolveFileArgs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-args-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.GLEAN_FILE_ARG_MAX_BYTES;
  });

  it("returns base args unchanged when file_args is undefined", async () => {
    const result = await resolveFileArgs(undefined, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("returns base args unchanged when file_args is null", async () => {
    const result = await resolveFileArgs(null, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("returns base args unchanged when file_args is empty", async () => {
    const result = await resolveFileArgs({}, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("reads file content and merges into args", async () => {
    const file = path.join(tmpDir, "draft.md");
    await fs.writeFile(file, "# Hello world\n\nlong content");

    const result = await resolveFileArgs({ body: file }, { channel: "C1" });

    expect(result).toEqual({
      channel: "C1",
      body: "# Hello world\n\nlong content",
    });
  });

  it("supports multiple file_args entries", async () => {
    const a = path.join(tmpDir, "a.md");
    const b = path.join(tmpDir, "b.md");
    await fs.writeFile(a, "content A");
    await fs.writeFile(b, "content B");

    const result = await resolveFileArgs(
      { body: a, summary: b },
      { channel: "C1" },
    );

    expect(result).toEqual({
      channel: "C1",
      body: "content A",
      summary: "content B",
    });
  });

  it("throws when file_args is not an object", async () => {
    await expect(resolveFileArgs("nope", {})).rejects.toThrow(FileArgsError);
    await expect(resolveFileArgs("nope", {})).rejects.toThrow(
      /must be an object/,
    );
  });

  it("throws when file_args is an array", async () => {
    await expect(resolveFileArgs(["a", "b"], {})).rejects.toThrow(
      /must be an object/,
    );
  });

  it("throws when path is not a string", async () => {
    await expect(
      resolveFileArgs({ body: 42 }, {}),
    ).rejects.toThrow(/non-empty string/);
  });

  it("throws when path is empty string", async () => {
    await expect(
      resolveFileArgs({ body: "" }, {}),
    ).rejects.toThrow(/non-empty string/);
  });

  it("throws when path is not absolute", async () => {
    await expect(
      resolveFileArgs({ body: "draft.md" }, {}),
    ).rejects.toThrow(/absolute/);
  });

  it("throws when file does not exist", async () => {
    await expect(
      resolveFileArgs({ body: path.join(tmpDir, "nope.md") }, {}),
    ).rejects.toThrow(FileArgsError);
  });

  it("throws when path is a directory", async () => {
    await expect(
      resolveFileArgs({ body: tmpDir }, {}),
    ).rejects.toThrow(/regular file/);
  });

  it("throws when file exceeds size cap", async () => {
    process.env.GLEAN_FILE_ARG_MAX_BYTES = "10";
    const file = path.join(tmpDir, "big.md");
    await fs.writeFile(file, "this is more than 10 bytes");

    await expect(resolveFileArgs({ body: file }, {})).rejects.toThrow(
      /exceeds.*limit/,
    );
  });

  it("respects GLEAN_FILE_ARG_MAX_BYTES override", async () => {
    process.env.GLEAN_FILE_ARG_MAX_BYTES = "100";
    const file = path.join(tmpDir, "ok.md");
    await fs.writeFile(file, "small content");

    const result = await resolveFileArgs({ body: file }, {});
    expect(result.body).toBe("small content");
  });

  it("throws when file_args key conflicts with arguments key", async () => {
    const file = path.join(tmpDir, "draft.md");
    await fs.writeFile(file, "content");

    await expect(
      resolveFileArgs({ body: file }, { body: "existing" }),
    ).rejects.toThrow(/conflicts/);
  });
});
