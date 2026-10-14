import { AsyncLocalStorage } from 'node:async_hooks';

/** HTTP receipt identity carried into the domain transaction. */
export const writeContext = new AsyncLocalStorage<{ id: string; owner: string; status: number }>();
