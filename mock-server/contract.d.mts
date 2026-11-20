export const CONTRACT_PATH: string;
export const MAX_REQUEST_BYTES: number;
/** The parsed OpenAPI document. */
export function loadContract(): Record<string, unknown>;
/** null when the body is allowed by the named schema of the contract, otherwise one sentence that names the first problem. */
export function problemWith(schemaName: string, body: unknown): string | null;
