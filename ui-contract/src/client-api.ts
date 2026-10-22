import type {} from 'cordis';
import type { Component } from 'vue';

export interface AdminPluginStatus {
  id: string;
  module_name: string;
  enabled: boolean;
  state: string;
  required: boolean;
  available: boolean;
  client_entry?: string;
  last_error?: { code: string; message?: string };
}

export interface AdminInfo {
  store_id: string;
  latest_seq: string;
  version: string;
  plugins: AdminPluginStatus[];
}

export interface AdminView {
  id: string;
  title: string;
  icon?: string;
  order?: number;
  component: Component;
}

export interface AdminViews {
  register(view: AdminView): () => void;
  list(): AdminView[];
  active(): AdminView | undefined;
  select(id: string): void;
}

export interface AdminClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

declare module 'cordis' {
  interface Context {
    views: AdminViews;
    client: AdminClient;
  }
}
