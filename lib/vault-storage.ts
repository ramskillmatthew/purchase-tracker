export type VaultKind = "note" | "link" | "file" | "guide" | "release" | "private";
export type VaultAttachment = { id: string; name: string; size: number; type: string };
export type VaultItem = { id: string; kind: VaultKind; title: string; folder: string; tags: string[]; content: string; url?: string; releaseDate?: string; pinned: boolean; private: boolean; createdAt: string; updatedAt: string; attachments: VaultAttachment[] };
async function json<T>(response:Response):Promise<T>{const body=await response.json() as T&{error?:string};if(!response.ok)throw new Error(body.error||"Vault request failed.");return body}
export async function loadVaultItems():Promise<VaultItem[]>{return json<VaultItem[]>(await fetch("/api/vault",{cache:"no-store"}))}
export async function createVaultItem(input:Omit<VaultItem,"id"|"createdAt"|"updatedAt"|"attachments">):Promise<VaultItem>{return json<VaultItem>(await fetch("/api/vault",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)}))}
export async function updateVaultItem(id:string,patch:Partial<Pick<VaultItem,"title"|"content"|"folder"|"tags"|"pinned"|"private"|"url"|"releaseDate">>):Promise<VaultItem>{return json<VaultItem>(await fetch(`/api/vault?id=${encodeURIComponent(id)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)}))}
export async function deleteVaultItem(id:string):Promise<void>{await json(await fetch(`/api/vault?id=${encodeURIComponent(id)}`,{method:"DELETE"}))}
export async function uploadVaultFiles(itemId:string,files:File[]):Promise<VaultAttachment[]>{const uploaded:VaultAttachment[]=[];for(const file of files){const form=new FormData();form.set("itemId",itemId);form.set("file",file);uploaded.push(await json<VaultAttachment>(await fetch("/api/vault/files",{method:"POST",body:form})))}return uploaded}
export function downloadVaultFile(file:VaultAttachment){window.location.href=`/api/vault/files/${encodeURIComponent(file.id)}`}
