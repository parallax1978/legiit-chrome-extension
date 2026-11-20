/**
 * Minimal typings for Chrome's built-in Prompt API (the global LanguageModel,
 * available to extensions from Chrome 138). No manifest permission is needed.
 * https://developer.chrome.com/docs/ai/prompt-api
 */
export {};

declare global {
  type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

  interface LanguageModelExpected {
    type: 'text';
    languages?: string[];
  }

  interface LanguageModelCoreOptions {
    expectedInputs?: LanguageModelExpected[];
    expectedOutputs?: LanguageModelExpected[];
  }

  interface LanguageModelCreateOptions extends LanguageModelCoreOptions {
    initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
    monitor?: (monitor: EventTarget) => void;
    signal?: AbortSignal;
  }

  interface LanguageModelPromptOptions {
    signal?: AbortSignal;
    /** A JSON Schema the reply must conform to. */
    responseConstraint?: unknown;
  }

  interface LanguageModelSession {
    prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
    destroy(): void;
  }

  interface LanguageModelStatic {
    availability(options?: LanguageModelCoreOptions): Promise<LanguageModelAvailability>;
    create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
  }

  var LanguageModel: LanguageModelStatic | undefined;
}
