/**
 * Shared types for the local Agent Bridge.
 *
 * The bridge is deliberately small: agents get a handful of semantic verbs and
 * never a shell. Every result is compact JSON; binary media is returned as a
 * cached artifact or a small preview image.
 */

export type AgentAuthor = 'user' | 'agent';

export type AgentErrorCode =
  | 'E_BAD_REQUEST'
  | 'E_NOT_FOUND'
  | 'E_EDITOR_OFFLINE'
  | 'E_NO_SEQUENCE'
  | 'E_NO_MEDIA_AT_TIME'
  | 'E_PATH_DENIED'
  | 'E_UNSUPPORTED_MEDIA'
  | 'E_APPROVAL_REQUIRED'
  | 'E_APPROVAL_TIMEOUT'
  | 'E_BUSY'
  | 'E_MODEL_MISSING'
  | 'E_NOT_IMPLEMENTED'
  | 'E_PRO_REQUIRED'
  | 'E_INTERNAL';

export type AgentToolError = {
  code: AgentErrorCode;
  message: string;
  next?: string;
};

export type AgentResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: AgentToolError;
  /** Base64 data URL for a small preview image. Stripped before MCP transport. */
  imageDataUrl?: string;
  meta?: {
    ms?: number;
    tool?: string;
    truncated?: boolean;
  };
};

export type ReviewReply = {
  id: string;
  body: string;
  author: AgentAuthor;
  createdAt: string;
};

export type ReviewScreenshot = {
  id: string;
  path: string;
  mime: string;
  width?: number;
  height?: number;
  bytes?: number;
};

export type ReviewThread = {
  id: string;
  sequenceId: string | null;
  sequenceName: string | null;
  revision: number | null;
  frame: number;
  time: number;
  timecode: string;
  body: string;
  author: AgentAuthor;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
  drawing: unknown[];
  screenshot: ReviewScreenshot | null;
  replies: ReviewReply[];
};

export type AgentJobStatus = 'running' | 'done' | 'error' | 'canceled';

export type AgentJob = {
  id: string;
  kind: string;
  status: AgentJobStatus;
  progress: number;
  message: string;
  createdAt: string;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};
