import { describe, it, expect } from "vitest";
import { buildGatewayMetadataHeader } from "../src/remote-client.js";

describe("buildGatewayMetadataHeader", () => {
  it("produces stable output without session ID", () => {
    const a = buildGatewayMetadataHeader();
    const b = buildGatewayMetadataHeader();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("produces different output with session ID", () => {
    const without = buildGatewayMetadataHeader();
    const with1 = buildGatewayMetadataHeader("session-abc");
    const with2 = buildGatewayMetadataHeader("session-xyz");
    expect(with1).not.toBe(without);
    expect(with1).not.toBe(with2);
  });

  it("output is valid base64", () => {
    const header = buildGatewayMetadataHeader("test-session");
    const decoded = Buffer.from(header, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    expect(Buffer.from(decoded).toString("base64")).toBe(header);
  });

  it("encodes workflow_id and source_info without session", () => {
    const header = buildGatewayMetadataHeader();
    const bytes = Buffer.from(header, "base64");

    // The proto bytes should contain "GLEAN_PLUGIN" (workflow_id, platform,
    // client_initiator) but no session ID string.
    const content = bytes.toString("utf-8");
    const matches = content.match(/GLEAN_PLUGIN/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(3); // workflow_id + platform + client_initiator
  });

  // Cross-language parity: must match Go's proto.Marshal output captured in
  // scio's go/core/mcp/server/proxy_tools_provider_test.go::
  // TestPluginGatewayRequestMetadata_NoSession. If this constant drifts, the
  // hand-rolled TS encoder has diverged from the proto schema — re-derive by
  // running the Go test and copying the asserted base64 here.
  it("matches Go proto.Marshal output (cross-language parity)", () => {
    expect(buildGatewayMetadataHeader()).toBe(
      "CgxHTEVBTl9QTFVHSU4iHBIMR0xFQU5fUExVR0lOGgxHTEVBTl9QTFVHSU4=",
    );
  });

  it("encodes session ID into the proto bytes", () => {
    const header = buildGatewayMetadataHeader("my-session-42");
    const bytes = Buffer.from(header, "base64");
    const content = bytes.toString("utf-8");
    expect(content).toContain("my-session-42");
  });
});
