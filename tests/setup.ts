import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';

const chromeMock = installChromeMock();
(globalThis as unknown as { __chromeMock: typeof chromeMock }).__chromeMock = chromeMock;

beforeEach(() => {
  chromeMock.reset();
});
