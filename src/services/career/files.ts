import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { getSupabase, isSupabaseEnabled } from "@/lib/supabase";

/**
 * Armazenamento privado dos PDFs de currículo.
 *
 * Com Supabase: bucket privado `career-resumes` (criado pela migração 0003),
 * com upload direto do navegador por URL assinada e download por URL
 * temporária. Sem Supabase: diretório local `.data/career/`, e o arquivo
 * passa pelo route handler de upload.
 *
 * As chaves de objeto sempre começam pelo owner_id, o que permite políticas
 * de Storage por prefixo quando a autenticação real estiver ativa.
 */

export const RESUME_BUCKET = "career-resumes";
const LOCAL_DIR = path.join(process.cwd(), ".data", "career");

/** Só o que produzimos: sem `..`, sem barras iniciais, sem caracteres estranhos. */
export function isSafeStorageKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(key) && !key.includes("..");
}

export function buildStorageKey(ownerId: string, versionId: string): string {
  return `${ownerId}/${versionId}.pdf`;
}

export function storageMode(): "supabase" | "local" {
  return isSupabaseEnabled() ? "supabase" : "local";
}

export interface DirectUploadTarget {
  mode: "direct";
  url: string;
  token: string;
  key: string;
}

export interface ServerUploadTarget {
  mode: "server";
  url: string;
  key: string;
}

/**
 * Onde o navegador deve mandar os bytes. Upload direto ao Storage dispensa
 * passar o PDF por uma function (limite de corpo da hospedagem); a validação
 * acontece depois, em `finalize`, lendo o objeto de volta.
 */
export async function createUploadTarget(
  key: string
): Promise<DirectUploadTarget | ServerUploadTarget> {
  const sb = getSupabase();
  if (sb && isSupabaseEnabled()) {
    const { data, error } = await sb.storage.from(RESUME_BUCKET).createSignedUploadUrl(key);
    if (error) throw new Error(`Storage: ${error.message}`);
    return { mode: "direct", url: data.signedUrl, token: data.token, key };
  }
  return { mode: "server", url: "/api/career/resumes/upload", key };
}

export async function putFile(key: string, bytes: Uint8Array): Promise<void> {
  if (!isSafeStorageKey(key)) throw new Error("Chave de arquivo inválida");
  const sb = getSupabase();
  if (sb && isSupabaseEnabled()) {
    const { error } = await sb.storage
      .from(RESUME_BUCKET)
      .upload(key, bytes, { contentType: "application/pdf", upsert: true });
    if (error) throw new Error(`Storage: ${error.message}`);
    return;
  }
  const file = path.join(LOCAL_DIR, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

export async function getFile(key: string): Promise<Uint8Array | null> {
  if (!isSafeStorageKey(key)) return null;
  const sb = getSupabase();
  if (sb && isSupabaseEnabled()) {
    const { data, error } = await sb.storage.from(RESUME_BUCKET).download(key);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }
  try {
    return new Uint8Array(await fs.readFile(path.join(LOCAL_DIR, key)));
  } catch {
    return null;
  }
}

export async function deleteFile(key: string): Promise<void> {
  if (!isSafeStorageKey(key)) return;
  const sb = getSupabase();
  if (sb && isSupabaseEnabled()) {
    await sb.storage.from(RESUME_BUCKET).remove([key]);
    return;
  }
  await fs.rm(path.join(LOCAL_DIR, key), { force: true });
}

/**
 * URL temporária de download (Supabase) ou a rota autenticada do app
 * (local). Nos dois casos o link não é público por tempo indeterminado.
 */
export async function createDownloadUrl(key: string, versionId: string): Promise<string> {
  const sb = getSupabase();
  if (sb && isSupabaseEnabled()) {
    const { data, error } = await sb.storage.from(RESUME_BUCKET).createSignedUrl(key, 300);
    if (!error && data) return data.signedUrl;
  }
  return `/api/career/resumes/${versionId}/download`;
}
