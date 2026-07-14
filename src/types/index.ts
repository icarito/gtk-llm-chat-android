export interface Conversation {
  id: string;
  name: string;
  model: string;
}

export interface Message {
  id: string;
  model: string;
  prompt: string;
  response: string;
  conversation_id: string;
  datetime_utc: string;
  prompt_json: string | null;
  response_json: string | null;
  options_json: string | null;
}

export interface ModelInfo {
  model_id: string;
  name: string;
  provider: string;
}

export interface ModelGroup {
  provider: string;
  models: ModelInfo[];
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface StreamMessage {
  type: 'send';
  prompt: string;
  temperature?: number;
  system?: string;
}

export interface StreamChunk {
  type: 'response';
  chunk: string;
}

export interface StreamFinished {
  type: 'finished';
  success: boolean;
}

export interface StreamError {
  type: 'error';
  message: string;
}

export interface StreamReady {
  type: 'ready';
  model_id: string;
}

export type ServerMessage = StreamChunk | StreamFinished | StreamError | StreamReady;

export interface ServerStatus {
  ok: boolean;
  version: string;
  db_path: string;
}

export interface ApiError {
  detail: string;
}
