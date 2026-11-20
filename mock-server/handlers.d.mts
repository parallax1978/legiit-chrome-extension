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
  session: { capabilities: string[] } & Record<string, unknown>;
  businesses: unknown;
  details: Record<string, unknown>;
  pulse: unknown;
  saved: {
    visibilitySnapshots: { id: string; businessId: string; payload: Record<string, unknown> }[];
    gapLists: { id: string; businessId: string; payload: Record<string, unknown> }[];
    competitors: { id: string; businessId: string; payload: Record<string, unknown> }[];
    contentDocuments: { id: string; businessId: string; payload: Record<string, unknown> }[];
    workspaces: { id: string; payload: Record<string, unknown> }[];
  };
  aiRequests: Record<string, unknown>[];
  requests: { method: string; path: string }[];
  nextId: number;
}

export const MOCK_TOKENS: { valid: string; invalid: string; limited: string };
export function createMockState(): MockState;
export function handleMockRequest(state: MockState, request: MockRequest): MockResponse;
