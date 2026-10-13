"use client";

// Watch a saved simulation run live over the backend's WebSocket.
// The address (with a 60-second, run-only stream token) comes from the
// website's server, so the session's own tokens never reach the browser.
// Frames can arrive many times per second; the screen updates at most once
// per animation frame.

import { useCallback, useEffect, useRef, useState } from "react";

import { describeError } from "../shared/errors.ts";
import { closeReason, parseStreamMessage, type LiveFrame } from "../shared/live.ts";
import { sessionRequest } from "./api.ts";

export type StreamPhase = "idle" | "connecting" | "running" | "paused" | "done" | "error";

export function useRunStream() {
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef<LiveFrame | null>(null);
  const drawRequest = useRef<number | null>(null);
  const generation = useRef(0);   // ignores events from a stream that was replaced

  const stop = useCallback(() => {
    generation.current += 1;
    const open = socket.current;
    socket.current = null;
    if (open) open.close(1000);
    if (drawRequest.current !== null) {
      cancelAnimationFrame(drawRequest.current);
      drawRequest.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async (runId: number, speed: number) => {
    stop();
    const mine = generation.current;
    latest.current = null;
    setFrame(null);
    setError(null);
    setPhase("connecting");

    let url: string;
    try {
      url = (await sessionRequest<{ url: string }>("stream", { run_id: runId, speed })).url;
    } catch (caught) {
      if (generation.current !== mine) return;
      setError(describeError(caught));
      setPhase("error");
      return;
    }
    if (generation.current !== mine) return;

    const ws = new WebSocket(url);
    socket.current = ws;
    let finished = false;
    const draw = () => {
      drawRequest.current = null;
      if (generation.current === mine && latest.current) setFrame(latest.current);
    };

    ws.onopen = () => {
      if (generation.current === mine) setPhase("running");
    };
    ws.onmessage = (event: MessageEvent) => {
      if (generation.current !== mine || typeof event.data !== "string") return;
      const message = parseStreamMessage(event.data);
      if (message.kind === "frame") {
        latest.current = message.frame;
        if (message.frame.done) {
          finished = true;
          setFrame(message.frame);
          setPhase("done");
        } else if (drawRequest.current === null) {
          drawRequest.current = requestAnimationFrame(draw);
        }
      } else if (message.kind === "status") {
        setPhase(message.paused ? "paused" : "running");
      }
      // Error messages are followed by a close; its code is explained below.
    };
    ws.onclose = (event: CloseEvent) => {
      if (generation.current !== mine) return;
      socket.current = null;
      const reason = closeReason(event.code, finished);
      if (reason) {
        setError(reason);
        setPhase("error");
      } else {
        setPhase("done");
      }
    };
  }, [stop]);

  const send = useCallback((action: "pause" | "resume") => {
    const open = socket.current;
    if (open && open.readyState === WebSocket.OPEN) open.send(JSON.stringify({ action }));
  }, []);
  const pause = useCallback(() => send("pause"), [send]);
  const resume = useCallback(() => send("resume"), [send]);

  const reset = useCallback(() => {
    stop();
    latest.current = null;
    setFrame(null);
    setError(null);
    setPhase("idle");
  }, [stop]);

  return { phase, frame, error, start, pause, resume, reset };
}
