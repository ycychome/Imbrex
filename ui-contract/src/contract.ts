import type {} from 'cordis';

export interface ViewClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export interface ViewContext {
  client: ViewClient;
  signal: AbortSignal;
}

/**
 * 把一个视图挂到 el 上，返回拆卸函数。
 * 框架无关：插件可以用 Vue、原生 DOM、预构建的其他框架产物，或 iframe。
 */
export type ViewMount = (el: HTMLElement, ctx: ViewContext) => void | (() => void);

export interface ViewDescriptor {
  /** ^[a-z][a-z0-9_-]{0,63}$，同时是 hash 路由段 */
  id: string;
  title: string;
  icon?: string;
  order?: number;
  mount: ViewMount;
}

export interface Views {
  register(view: ViewDescriptor): () => void;
  list(): ViewDescriptor[];
  active(): ViewDescriptor | undefined;
  select(id: string): void;
}

declare module 'cordis' {
  interface Context {
    views: Views;
    client: ViewClient;
  }
}
