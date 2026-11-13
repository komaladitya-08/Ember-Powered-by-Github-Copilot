/**
 * The Secure Form's preload (the vault, app/main/vault/form.ts): it bridges only the form's three channels of
 * VAULT_IPC ("vault:form", "vault:submit", "vault:cancel"), nothing else. Main takes them only from this window's own
 * page and only for the form on screen. What is typed goes to main once, to be sealed, and nothing main answers ever
 * holds a value.
 */

import { contextBridge, ipcRenderer } from "electron";
import { VAULT_IPC, type VaultFormView, type VaultSubmitResult } from "../shared/vault";
import type { VaultFormApi } from "../renderer/vault/api";

const api: VaultFormApi = {
  form: () => ipcRenderer.invoke(VAULT_IPC.form) as Promise<VaultFormView | null>,
  submit: (id, values) => ipcRenderer.invoke(VAULT_IPC.submit, id, values) as Promise<VaultSubmitResult>,
  cancel: id => ipcRenderer.send(VAULT_IPC.cancel, id),
};

contextBridge.exposeInMainWorld("emberVaultForm", api);
