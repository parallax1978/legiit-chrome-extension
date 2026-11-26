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
  /** The businesses that both users can read and save into. */
  businesses: unknown;
  details: Record<string, { competitors: { name: string; domains?: string[] }[] } & Record<string, unknown>>;
  /** Business Details of the businesses that belong to one user alone, by user id. */
  ownDetails: Record<string, Record<string, { id: string; name: string; domains: string[]; competitors: { name: string; domains?: string[] }[] } & Record<string, unknown>>>;
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
  /** Accounts created from the extension's first screen: token → session. */
  accounts: Map<string, { user: { id: string; name: string; email: string }; plan: string; capabilities: string[] }>;
  /** Email addresses from the first screen, with their latest code: lower-case address → sign-up. */
  signups: Map<string, { email: string; code: string; wrong: number }>;
}

export const MOCK_TOKENS: { valid: string; invalid: string; limited: string };
/** A business of the second user alone ("limited-token"): the first user's token cannot reach it. */
export const MOCK_OTHER_BUSINESS_ID: string;
export const CORS_HEADERS: Record<string, string>;
/** What a new free account of the mock gets. */
export const MOCK_NEW_ACCOUNT_CAPABILITIES: string[];
/** The code the mock "emails" for every sign-up. */
export const MOCK_SIGNUP_CODE: string;
export function createMockState(): MockState;
export function handleMockRequest(state: MockState, request: MockRequest): MockResponse;
