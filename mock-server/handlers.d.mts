export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | null;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MockState {
  /** The user of "demo-token". */
  session: { capabilities: string[] } & Record<string, unknown>;
  /** The user of "limited-token". */
  limitedSession: { user: { id: string; name: string; email: string }; plan: string; capabilities: string[] };
  businesses: unknown;
  details: Record<string, { competitors: { name: string; domains?: string[] }[] } & Record<string, unknown>>;
  competitorIds: Record<string, string[]>;
  pulse: unknown;
  saved: {
    visibilitySnapshots: { id: string; businessId: string; payload: Record<string, unknown> }[];
    gapLists: { id: string; businessId: string; payload: Record<string, unknown> }[];
    competitors: { id: string; businessId: string; payload: Record<string, unknown> }[];
    contentDocuments: { id: string; businessId: string; payload: Record<string, unknown> }[];
    workspaces: { id: string; userId: string; payload: Record<string, unknown> }[];
  };
  aiRequests: Record<string, unknown>[];
  requests: { method: string; path: string; idempotencyKey: string | null }[];
  replies: Map<string, MockResponse>;
  nextId: number;
}

export const MOCK_TOKENS: { valid: string; invalid: string; limited: string };
export const CORS_HEADERS: Record<string, string>;
export function createMockState(): MockState;
export function handleMockRequest(state: MockState, request: MockRequest): MockResponse;
