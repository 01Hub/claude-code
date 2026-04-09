import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock config before imports
const mockConfig = {
  port: 3000,
  host: "0.0.0.0",
  apiKeys: ["test-api-key"],
  baseUrl: "http://localhost:3000",
  pollTimeout: 8,
  heartbeatInterval: 20,
  jwtExpiresIn: 3600,
  disconnectTimeout: 300,
};

mock.module("../config", () => ({
  config: mockConfig,
  getBaseUrl: () => "http://localhost:3000",
}));

import { storeReset } from "../store";
import { getEventBus, removeEventBus, getAllEventBuses } from "../transport/event-bus";
import {
  ingestBridgeMessage,
  handleWebSocketOpen,
  handleWebSocketMessage,
  handleWebSocketClose,
  closeAllConnections,
} from "../transport/ws-handler";

// Minimal WSContext mock
function createMockWs(readyState = 1) {
  const sent: string[] = [];
  return {
    readyState,
    send: (data: string) => sent.push(data),
    close: (_code?: number, _reason?: string) => {},
    getSentData: () => sent,
  } as any;
}

describe("ws-handler", () => {
  beforeEach(() => {
    storeReset();
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key);
    }
    closeAllConnections();
  });

  describe("ingestBridgeMessage", () => {
    test("ignores keep_alive messages", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", { type: "keep_alive" });
      expect(events).toHaveLength(0);
    });

    test("derives type from message.role for user messages", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", {
        message: { role: "user", content: "hello" },
        uuid: "u1",
      });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("user");
      expect((events[0] as any).direction).toBe("inbound");
    });

    test("derives type from message.role for assistant messages", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", {
        message: { role: "assistant", content: [{ type: "text", text: "response" }] },
        uuid: "u2",
      });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("assistant");
      const payload = (events[0] as any).payload as Record<string, unknown>;
      expect(payload.content).toBe("response");
    });

    test("derives type from explicit type field", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", { type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("control_request");
    });

    test("derives result type from subtype/result fields", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", { subtype: "success", uuid: "u3", result: "done" });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("result");
    });

    test("derives system type from session_id field", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", { session_id: "s1", init: true });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("system");
    });

    test("handles control_response type", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", {
        type: "control_response",
        response: { subtype: "success" },
      });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("control_response");
    });

    test("handles partial_assistant type", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", {
        type: "partial_assistant",
        message: { content: "partial..." },
        uuid: "u4",
      });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("partial_assistant");
    });

    test("falls back to unknown type", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));
      ingestBridgeMessage("s1", { data: "something" });
      expect(events).toHaveLength(1);
      expect((events[0] as any).type).toBe("unknown");
    });
  });

  describe("handleWebSocketOpen", () => {
    test("subscribes to event bus and replays missed events", () => {
      // Publish some events before WS connects
      const bus = getEventBus("s1");
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: { content: "hello" }, direction: "outbound" });
      bus.publish({ id: "e2", sessionId: "s1", type: "assistant", payload: { content: "hi" }, direction: "inbound" });

      const ws = createMockWs();
      handleWebSocketOpen(ws, "s1");

      // Should have replayed the outbound event (only outbound events are forwarded to WS)
      const sent = ws.getSentData();
      expect(sent.length).toBeGreaterThanOrEqual(1);
      // First message should be the outbound user event
      const msg = JSON.parse(sent[0]);
      expect(msg.type).toBe("user");
    });

    test("replaces existing connection for same session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      handleWebSocketOpen(ws1, "s2");
      handleWebSocketOpen(ws2, "s2");

      // ws2 should be the active connection
      const bus = getEventBus("s2");
      bus.publish({ id: "e1", sessionId: "s2", type: "user", payload: { content: "test" }, direction: "outbound" });
      expect(ws2.getSentData().length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("handleWebSocketMessage", () => {
    test("parses NDJSON and ingests each message", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));

      const ws = createMockWs();
      const data = JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n" +
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" } }) + "\n";
      handleWebSocketMessage(ws, "s1", data);
      expect(events).toHaveLength(2);
    });

    test("ignores malformed JSON lines", () => {
      const bus = getEventBus("s1");
      const events: unknown[] = [];
      bus.subscribe((e) => events.push(e));

      const ws = createMockWs();
      handleWebSocketMessage(ws, "s1", "not json\n");
      expect(events).toHaveLength(0);
    });
  });

  describe("handleWebSocketClose", () => {
    test("cleans up on close", () => {
      const ws = createMockWs();
      handleWebSocketOpen(ws, "s3");
      handleWebSocketClose(ws, "s3", 1000, "done");

      // After close, publishing events should not cause errors
      const bus = getEventBus("s3");
      expect(() =>
        bus.publish({ id: "e1", sessionId: "s3", type: "user", payload: {}, direction: "outbound" })
      ).not.toThrow();
    });
  });

  describe("closeAllConnections", () => {
    test("closes all active connections", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      handleWebSocketOpen(ws1, "s1");
      handleWebSocketOpen(ws2, "s2");
      closeAllConnections();
      // No errors thrown
    });

    test("no-op when no connections", () => {
      expect(() => closeAllConnections()).not.toThrow();
    });
  });
});
