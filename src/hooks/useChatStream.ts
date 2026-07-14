import { useRef, useState, useCallback, useEffect } from 'react';
import type { ConnectionState, ServerMessage } from '@/types';
import { buildWebSocketUrl } from '@/api/client';

interface UseChatStreamOptions {
  cid: string;
  onChunk: (chunk: string) => void;
  onFinished: (success: boolean) => void;
  onError: (message: string) => void;
  onReady: (modelId: string) => void;
}

interface UseChatStreamReturn {
  sendMessage: (prompt: string, system?: string, temperature?: number) => void;
  setModel: (modelId: string) => void;
  cancelStream: () => void;
  connectionState: ConnectionState;
  reconnect: () => void;
}

export function useChatStream({
  cid,
  onChunk,
  onFinished,
  onError,
  onReady,
}: UseChatStreamOptions): UseChatStreamReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const url = buildWebSocketUrl(cid);
    setConnectionState('connecting');
    const ws = new WebSocket(url);

    ws.onopen = () => {
      setConnectionState('connected');
      reconnectAttempts.current = 0;
    };

    ws.onmessage = (event: WebSocketMessageEvent) => {
      try {
        const data: ServerMessage = JSON.parse(event.data as string);

        if (data.type === 'response') {
          onChunk(data.chunk);
        } else if (data.type === 'finished') {
          onFinished(data.success);
        } else if (data.type === 'error') {
          setConnectionState('error');
          onError(data.message);
        } else if (data.type === 'ready') {
          onReady(data.model_id);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      setConnectionState('error');
    };

    ws.onclose = () => {
      setConnectionState('disconnected');
      wsRef.current = null;

      if (reconnectAttempts.current < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };

    wsRef.current = ws;
  }, [cid, onChunk, onFinished, onError, onReady]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttempts.current = maxReconnectAttempts;
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const sendMessage = useCallback(
    (prompt: string, system?: string, temperature?: number) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'send',
            prompt,
            ...(system !== undefined && { system }),
            ...(temperature !== undefined && { temperature }),
          }),
        );
      } else {
        onError('Not connected to server');
      }
    },
    [onError],
  );

  const setModel = useCallback(
    (modelId: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'set_model', model_id: modelId }));
      }
    },
    [],
  );

  const cancelStream = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
  }, []);

  const reconnect = useCallback(() => {
    disconnect();
    reconnectAttempts.current = 0;
    connect();
  }, [disconnect, connect]);

  return { sendMessage, setModel, cancelStream, connectionState, reconnect };
}
