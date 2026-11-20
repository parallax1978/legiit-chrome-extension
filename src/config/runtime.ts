import { WAYBACK_ORIGIN } from './constants';

/** Injected by the bundler from LEGIIT_API_BASE_URL (see wxt.config.ts). */
declare const __LEGIIT_API_BASE_URL__: string;

export const LEGIIT_API_BASE_URL: string = __LEGIIT_API_BASE_URL__;
export const LEGIIT_ORIGIN: string = new URL(LEGIIT_API_BASE_URL).origin;
export { WAYBACK_ORIGIN };
