export interface AdminPluginStatus {
  id: string;
  lifecycle_revision: string;
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
